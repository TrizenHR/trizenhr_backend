// Helper note: This file adds organizationId parameter to methods for multi-tenant support
// Key changes:
// 1. CreateUserData includes organizationId
// 2. All queries filter by organizationId when provided
// 3. Email/employeeId uniqueness is per-organization
// 4. Supervisor validation checks same organization

import crypto from 'crypto';
import mongoose from 'mongoose';
import User, { AuthProvider, IUser, UserRole } from '../models/User';
import Organization from '../models/Organization';
import Department from '../models/Department';
import AttendancePolicy, { PolicyStatus } from '../models/AttendancePolicy';
import Subscription, {
} from '../models/Subscription';
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from '../utils/AppError';
import { deleteUsersAndRelatedData } from './userCascadeDelete';
import {
  assertEmailAvailableForInvitation,
  resetUserInvitationState,
} from './invitationValidationService';

export interface CreateUserData {
  organizationId?: string;
  email: string;
  password?: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  department?: string;
  designation?: string;
  employmentStatus?: string;
  supervisorId?: string;
  employeeId?: string;
  attendancePolicyId?: string;
  leavePolicyId?: string;
  payrollPolicyId?: string;
  joiningDate?: Date | string;
}

export interface UpdateUserData {
  firstName?: string;
  lastName?: string;
  department?: string;
  designation?: string;
  employmentStatus?: string;
  supervisorId?: string;
  employeeId?: string;
  attendancePolicyId?: string;
  leavePolicyId?: string;
  payrollPolicyId?: string;
  joiningDate?: Date | string;
  fieldTrackingEnabled?: boolean;
  fieldTrackingIntervalMinutes?: number;
}

export interface UserFilters {
  role?: UserRole;
  department?: string;
  isActive?: boolean;
  search?: string;
  organizationId?: string; // Optional override for Super Admin
}

class UserService {
  private async assertCanAddActiveUser(organizationId: string): Promise<void> {
    const latestSubscription = await Subscription.findOne({ organizationId })
      .select('status employeeLimit')
      .sort({ createdAt: -1 })
      .lean();

    if (!latestSubscription) {
      return;
    }

    const effectiveLimit = Number(latestSubscription.employeeLimit || 0);

    if (!effectiveLimit || effectiveLimit < 1) {
      return;
    }

    const activeUsers = await User.countDocuments({
      organizationId: new mongoose.Types.ObjectId(organizationId),
      isActive: true,
    });

    if (activeUsers >= effectiveLimit) {
      throw new ForbiddenError(
        `Your subscription allows up to ${effectiveLimit} active employees. Please upgrade your plan to add more users.`
      );
    }
  }

  private async applyDepartmentPolicyDefaults(
    userData: CreateUserData
  ): Promise<CreateUserData> {
    if (!userData.organizationId || !userData.department) {
      return userData;
    }

    const dept = await Department.findOne({
      organizationId: userData.organizationId,
      name: { $regex: `^${userData.department.trim()}$`, $options: 'i' },
    }).lean();

    if (!dept) return userData;

    return {
      ...userData,
      leavePolicyId: userData.leavePolicyId ?? dept.defaultLeavePolicyId?.toString(),
      payrollPolicyId: userData.payrollPolicyId ?? dept.defaultPayrollPolicyId?.toString(),
    };
  }

  private async validatePolicyAssignments(
    organizationId: string,
    data: {
      attendancePolicyId?: string;
      leavePolicyId?: string;
      payrollPolicyId?: string;
    }
  ): Promise<void> {
    if (data.attendancePolicyId) {
      const policy = await AttendancePolicy.findOne({
        _id: data.attendancePolicyId,
        organizationId,
        status: PolicyStatus.ACTIVE,
      });
      if (!policy) {
        throw new BadRequestError('Active attendance policy not found in this organization');
      }
    }
  }

  private async reactivateOrgUser(
    existing: IUser,
    userData: CreateUserData,
    createdByUserId: string
  ): Promise<IUser> {
    if (userData.supervisorId) {
      const supervisor = await User.findOne({
        _id: userData.supervisorId,
        organizationId: userData.organizationId,
        isActive: true,
      });
      if (!supervisor) {
        throw new NotFoundError('Supervisor not found in this organization');
      }
      if (supervisor.role !== UserRole.SUPERVISOR && supervisor.role !== UserRole.ADMIN) {
        throw new BadRequestError('Assigned supervisor must have supervisor or admin role');
      }
    }

    existing.email = userData.email.toLowerCase().trim();
    existing.firstName = userData.firstName;
    existing.lastName = userData.lastName;
    existing.role = userData.role;
    existing.department = userData.department;
    existing.designation = userData.designation;
    existing.employmentStatus = userData.employmentStatus;
    existing.supervisorId = userData.supervisorId
      ? new mongoose.Types.ObjectId(userData.supervisorId)
      : undefined;
    existing.employeeId = userData.employeeId;
    existing.isActive = true;
    existing.createdBy = new mongoose.Types.ObjectId(createdByUserId);
    existing.authProvider = AuthProvider.LOCAL;

    const isInviteFlow = !userData.password?.trim();
    if (isInviteFlow) {
      existing.password = crypto.randomBytes(32).toString('hex');
      existing.invitationPending = true;
      existing.invitationAcceptedAt = undefined;
      existing.profileComplete = false;
    } else {
      existing.password = userData.password!;
      existing.invitationPending = false;
      existing.profileComplete = true;
    }

    await existing.save();
    return existing;
  }

  /**
   * Build a 2-char uppercase prefix from a name string (used for dept/role segment).
   * e.g. "Engineering" → "EN", "Human Resources" → "HR"
   */
  private buildPrefix(name: string): string {
    const clean = name.trim().toUpperCase().replace(/[^A-Z0-9\s]/g, '');
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      return words.map(w => w[0]).join('').slice(0, 2).padEnd(2, 'X');
    }
    return ((words[0] || 'XX').slice(0, 2)).padEnd(2, 'X');
  }

  /**
   * Map a UserRole to a 2-char role code.
   */
  private rolePrefix(role: UserRole): string {
    const map: Record<UserRole, string> = {
      [UserRole.SUPER_ADMIN]: 'SA',
      [UserRole.ADMIN]: 'AD',
      [UserRole.HR]: 'HR',
      [UserRole.SUPERVISOR]: 'MG',
      [UserRole.EMPLOYEE]: 'EM',
    };
    return map[role] ?? 'US';
  }

  /**
   * Generate the next Employee ID — always exactly 8 characters.
   *
   * Format: {ORGCODE3}{ROLE2}{SEQ3}
   *   e.g. TRZ + AD + 001 = TRZAD001  (Company Admin)
   *        TRZ + HR + 001 = TRZHR001  (HR Admin)
   *        TRZ + MG + 001 = TRZMG001  (Manager)
   *        TRZ + EM + 001 = TRZEM001  (Employee)
   *
   * ORGCODE3 = unique 3-char code stored on the Organization (e.g. TRZ, ACM).
   * ROLE2    = 2-char role code.
   * SEQ3     = 3-digit sequence 001–999, scoped to same prefix within the org.
   */
  /**
   * Generate the next Employee ID.
   *
   * Format:
   *   Company Admin  → {ORGCODE3}{ROLE2}{SEQ3}          = 8 chars  e.g. TRZAD001
   *   HR/Mgr/Employee→ {ORGCODE3}{DEPT2}{ROLE2}{SEQ3}   = 10 chars e.g. TRZENЕМ001
   *
   * ORGCODE3 = unique 3-char code stored on the Organization (e.g. TRZ).
   * DEPT2    = first 2 chars of department name (non-admin only).
   * ROLE2    = 2-char role code (AD / HR / MG / EM).
   * SEQ3     = 3-digit sequence 001–999, scoped to same prefix within the org.
   */
  async generateEmployeeId(
    organizationId: string,
    role: UserRole,
    departmentName?: string
  ): Promise<string> {
    const org = await Organization.findById(organizationId).select('orgCode').lean();
    if (!org) throw new NotFoundError('Organization not found');

    const orgCode = (org as any).orgCode || organizationId.slice(-3).toUpperCase();
    const rolePfx = this.rolePrefix(role);                  // 2 chars

    let idPrefix: string;
    if (role === UserRole.ADMIN) {
      // Company Admin: no department → ORGCODE + ROLE
      idPrefix = `${orgCode}${rolePfx}`;                    // 5 chars e.g. TRZAD
    } else {
      if (!departmentName) {
        throw new BadRequestError(
          'Department is required for non-admin users. Please create departments first.'
        );
      }
      const deptPfx = this.buildPrefix(departmentName);     // 2 chars e.g. EN
      // ORGCODE + DEPT + ROLE
      idPrefix = `${orgCode}${deptPfx}${rolePfx}`;          // 7 chars e.g. TRZENЕМ
    }

    // Count existing IDs with this exact prefix + 3-digit seq
    const count = await User.countDocuments({
      organizationId: new mongoose.Types.ObjectId(organizationId),
      employeeId: { $regex: `^${idPrefix}\\d{3}$` },
    });

    const seq = String(count + 1).padStart(3, '0');
    return `${idPrefix}${seq}`;
  }

  /**
   * Preview the next Employee ID (used by the frontend suggestion endpoint).
   * Returns the generated ID and a sample of existing IDs with the same prefix.
   */
  async getNextEmployeeId(
    organizationId: string,
    role?: UserRole,
    departmentName?: string
  ): Promise<{ nextEmployeeId: string; existingSample: string[] }> {
    const effectiveRole = role ?? UserRole.EMPLOYEE;

    // For non-admin roles, department is part of the ID — need it to generate preview
    if (effectiveRole !== UserRole.ADMIN && !departmentName) {
      return { nextEmployeeId: '', existingSample: [] };
    }

    const nextEmployeeId = await this.generateEmployeeId(
      organizationId,
      effectiveRole,
      departmentName
    );

    // Derive the prefix to fetch existing samples
    const org = await Organization.findById(organizationId).select('orgCode').lean();
    const orgCode = (org as any)?.orgCode || organizationId.slice(-3).toUpperCase();
    const rolePfx = this.rolePrefix(effectiveRole);

    const idPrefix = effectiveRole === UserRole.ADMIN
      ? `${orgCode}${rolePfx}`                              // 5 chars e.g. TRZAD
      : `${orgCode}${this.buildPrefix(departmentName!)}${rolePfx}`; // 7 chars e.g. TRZENЕМ

    const existingSampleDocs = await User.find({
      organizationId,
      employeeId: { $regex: `^${idPrefix}\\d{3}$` },
    })
      .select('employeeId')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    return {
      nextEmployeeId,
      existingSample: existingSampleDocs.map((d: any) => d.employeeId).filter(Boolean),
    };
  }

  /**
   * Create a new user (Super Admin/Admin/HR only)
   */
  async createUser(userData: CreateUserData, createdByUserId: string): Promise<IUser> {
    // Get the creator user to check permissions
    const createdBy = await User.findById(createdByUserId);
    if (!createdBy) {
      throw new NotFoundError('Creator user not found');
    }

    // Enforce role-based user creation restrictions
    if (createdBy.role === UserRole.HR) {
      if (userData.role !== UserRole.EMPLOYEE) {
        throw new ForbiddenError('HR can only create Employee users');
      }
    }

    if (createdBy.role === UserRole.ADMIN) {
      if (userData.role === UserRole.SUPER_ADMIN || userData.role === UserRole.ADMIN) {
        throw new ForbiddenError('Admin cannot create Super Admin or other Admin users');
      }
    }

    // SUPERVISORS and EMPLOYEES cannot create any users
    if (createdBy.role === UserRole.SUPERVISOR || createdBy.role === UserRole.EMPLOYEE) {
      throw new ForbiddenError('Insufficient permissions to create users');
    }

    // Special handling for Super Admin
    if (userData.role === UserRole.SUPER_ADMIN) {
      if (!userData.password) {
        throw new BadRequestError('Password is required for Super Admin users');
      }
      // Only Super Admin can create another Super Admin
      if (createdBy.role !== UserRole.SUPER_ADMIN) {
        throw new ForbiddenError('Only Super Admin can create other Super Admin users');
      }

      // Super Admin should NOT have organizationId
      if (userData.organizationId) {
        throw new BadRequestError('Super Admin users should not have an organization ID');
      }

      const normalizedEmail = userData.email.toLowerCase().trim();

      const existingActiveSuperAdmin = await User.findOne({
        email: normalizedEmail,
        role: UserRole.SUPER_ADMIN,
        isActive: true,
      });
      if (existingActiveSuperAdmin) {
        throw new ConflictError('Super Admin with this email already exists');
      }

      if (!userData.password?.trim()) {
        throw new BadRequestError('Password is required when creating a Super Admin');
      }

      const existingInactiveSuperAdmin = await User.findOne({
        email: normalizedEmail,
        role: UserRole.SUPER_ADMIN,
        isActive: false,
      });
      if (existingInactiveSuperAdmin) {
        existingInactiveSuperAdmin.password = userData.password;
        existingInactiveSuperAdmin.firstName = userData.firstName;
        existingInactiveSuperAdmin.lastName = userData.lastName;
        existingInactiveSuperAdmin.isActive = true;
        existingInactiveSuperAdmin.createdBy = new mongoose.Types.ObjectId(createdByUserId);
        existingInactiveSuperAdmin.authProvider = AuthProvider.LOCAL;
        await existingInactiveSuperAdmin.save();
        return existingInactiveSuperAdmin;
      }

      // Create Super Admin (no organization-related validations needed)
      const superAdmin = new User({
        email: normalizedEmail,
        password: userData.password.trim(),
        firstName: userData.firstName,
        lastName: userData.lastName,
        role: UserRole.SUPER_ADMIN,
        createdBy: createdByUserId,
      });

      await superAdmin.save();
      return superAdmin;
    }

    // For non-Super Admin users, organizationId is required
    if (!userData.organizationId) {
      throw new BadRequestError('Organization ID is required for non-Super Admin users');
    }

    if (!userData.password) {
      userData.password = crypto.randomBytes(12).toString('hex');
    }

    // For non-admin roles, department is required (needed for Employee ID generation)
    if (userData.role !== UserRole.ADMIN) {
      if (!userData.department || !userData.department.trim()) {
        throw new BadRequestError(
          'Department is required. Please create a department first before adding users.'
        );
      }

      // Verify the department actually exists in this organization
      const deptExists = await Department.findOne({
        organizationId: userData.organizationId,
        name: { $regex: `^${userData.department.trim()}$`, $options: 'i' },
      });
      if (!deptExists) {
        throw new BadRequestError(
          `Department "${userData.department}" does not exist in this organization. Please create it first.`
        );
      }
    }

    // Auto-generate employeeId based on org + role + department
    if (!userData.employeeId) {
      userData.employeeId = await this.generateEmployeeId(
        userData.organizationId,
        userData.role,
        userData.department
      );
    } else {
      // If manually provided, keep as-is (trim only)
      const trimmed = String(userData.employeeId).trim();
      if (!trimmed) {
        throw new BadRequestError('Invalid employee ID format');
      }
      userData.employeeId = trimmed;
    }

    const normalizedEmail = userData.email.toLowerCase().trim();

    const existingActiveUser = await User.findOne({
      email: normalizedEmail,
      organizationId: userData.organizationId,
      isActive: true,
    });
    if (existingActiveUser) {
      throw new ConflictError('Email already in use in this organization');
    }

    const existingInactiveUser = await User.findOne({
      email: normalizedEmail,
      organizationId: userData.organizationId,
      isActive: false,
    });

    await this.assertCanAddActiveUser(userData.organizationId);

    if (existingInactiveUser) {
      return this.reactivateOrgUser(existingInactiveUser, userData, createdByUserId);
    }

    await assertEmailAvailableForInvitation(normalizedEmail);
    const existingEmployee = await User.findOne({
      employeeId: userData.employeeId,
      organizationId: userData.organizationId,
      isActive: true,
    });
    if (existingEmployee) {
      throw new ConflictError('Employee ID already in use in this organization');
    }

    // Validate supervisor if provided (must be in same organization)
    if (userData.supervisorId) {
      const supervisor = await User.findOne({
        _id: userData.supervisorId,
        organizationId: userData.organizationId
      });
      if (!supervisor) {
        throw new NotFoundError('Supervisor not found in this organization');
      }
      if (supervisor.role !== UserRole.SUPERVISOR && supervisor.role !== UserRole.ADMIN) {
        throw new BadRequestError('Assigned supervisor must have supervisor or admin role');
      }
    }

    const withDefaults = await this.applyDepartmentPolicyDefaults(userData);
    await this.validatePolicyAssignments(userData.organizationId, withDefaults);

    // Invite flow: no password in request — user sets it via email link
    const isInviteFlow = !userData.password?.trim();
    const password =
      userData.password?.trim() ||
      crypto.randomBytes(32).toString('hex');

    const user = new User({
      ...withDefaults,
      email: normalizedEmail,
      password,
      invitationPending: isInviteFlow,
      profileComplete: isInviteFlow ? false : true,
      createdBy: createdByUserId,
      attendancePolicyId: withDefaults.attendancePolicyId
        ? new mongoose.Types.ObjectId(withDefaults.attendancePolicyId)
        : undefined,
      leavePolicyId: withDefaults.leavePolicyId
        ? new mongoose.Types.ObjectId(withDefaults.leavePolicyId)
        : undefined,
      payrollPolicyId: withDefaults.payrollPolicyId
        ? new mongoose.Types.ObjectId(withDefaults.payrollPolicyId)
        : undefined,
      joiningDate: withDefaults.joiningDate
        ? new Date(withDefaults.joiningDate)
        : undefined,
    });

    await user.save();

    return user;
  }

  /**
   * Get all users with optional filters (role-based access)
   * organizationId is required for non-Super Admin users
   * requesterRole and requesterId are used to enforce supervisor team-only access
   */
  async getAllUsers(
    filters?: UserFilters, 
    organizationId?: string, 
    requesterRole?: UserRole
  ): Promise<IUser[]> {
    const query: any = {};

    const effectiveOrgId = filters?.organizationId || organizationId;

    // Enforce organization isolation for all roles except Super Admin
    if (requesterRole !== UserRole.SUPER_ADMIN) {
      if (!organizationId) {
        throw new ForbiddenError('Organization identification is required');
      }
      query.organizationId = new mongoose.Types.ObjectId(organizationId);
    } else if (effectiveOrgId) {
      // Super Admin can optionally filter by organization
      if (!mongoose.Types.ObjectId.isValid(effectiveOrgId)) {
        throw new BadRequestError('Invalid organization ID');
      }
      query.organizationId = new mongoose.Types.ObjectId(effectiveOrgId);
    }

    // SUPERVISORS (Managers) visibility rules
    // Requirement: Show users in their organization who are NOT HR or Company Admin
    if (requesterRole === UserRole.SUPERVISOR || (requesterRole as string) === 'manager') {
      // Exclude: Super Admin, Admin (Company Admin), and HR
      query.role = { 
        $nin: [UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.HR] 
      };
      
      // If a specific role filter was requested, combine it (still within allowed roles)
      if (filters?.role) {
        const forbiddenRoles = [UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.HR];
        if (forbiddenRoles.includes(filters.role)) {
          query.role = '__HIDDEN__';
        } else {
          query.role = filters.role;
        }
      }
    }

    // HR can only see HR, SUPERVISOR, and EMPLOYEE roles (NOT Admin or Super Admin)
    if (requesterRole === UserRole.HR) {
      const allowedRolesForHR = [UserRole.HR, UserRole.SUPERVISOR, UserRole.EMPLOYEE];
      if (filters?.role) {
        if (!allowedRolesForHR.includes(filters.role)) {
          query.role = '__HIDDEN__'; // Force no results
        } else {
          query.role = filters.role;
        }
      } else {
        query.role = { $in: allowedRolesForHR };
      }
    }

    // Apply role filter if not already set by hierarchy rules above
    if (filters?.role && !query.role) {
      query.role = filters.role;
    }

    if (filters?.department) {
      query.department = filters.department;
    }

    if (filters?.isActive !== undefined) {
      query.isActive = filters.isActive;
    }

    // Search by name or email
    if (filters?.search) {
      query.$or = [
        { firstName: { $regex: filters.search, $options: 'i' } },
        { lastName: { $regex: filters.search, $options: 'i' } },
        { email: { $regex: filters.search, $options: 'i' } },
        { employeeId: { $regex: filters.search, $options: 'i' } },
      ];
    }

    const users = await User.find(query)
      .populate('supervisorId', 'firstName lastName email role')
      .populate('createdBy', 'firstName lastName email')
      .sort({ createdAt: -1 });

    return users;
  }

  /**
   * Get users by department
   */
  async getUsersByDepartment(department: string, organizationId?: string): Promise<IUser[]> {
    const query: any = { department, isActive: true };
    if (organizationId) {
      query.organizationId = organizationId;
    }

    const users = await User.find(query)
      .populate('supervisorId', 'firstName lastName email')
      .sort({ firstName: 1 });

    return users;
  }

  /**
   * Get team members for a supervisor.
   * Primary: users with supervisorId === supervisorId.
   * Fallback: users in the same department as the supervisor (excludes Admin / HR / SuperAdmin).
   */
  async getTeamMembers(supervisorId: string, organizationId?: string): Promise<IUser[]> {
    const query: any = {
      supervisorId: new mongoose.Types.ObjectId(supervisorId),
      isActive: true,
    };
    if (organizationId) {
      query.organizationId = new mongoose.Types.ObjectId(organizationId);
    }

    let users = await User.find(query)
      .populate('supervisorId', 'firstName lastName email')
      .sort({ firstName: 1 });

    // Fallback: no explicit supervisorId links found — use department-based membership
    if (users.length === 0) {
      const supervisor = await User.findById(supervisorId).select('department organizationId').lean();
      if (supervisor?.department) {
        const deptQuery: any = {
          department: supervisor.department,
          isActive: true,
          role: { $nin: [UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.HR] },
        };
        const effectiveOrgId = organizationId || supervisor.organizationId?.toString();
        if (effectiveOrgId) {
          deptQuery.organizationId = new mongoose.Types.ObjectId(effectiveOrgId);
        }
        users = await User.find(deptQuery)
          .populate('supervisorId', 'firstName lastName email')
          .sort({ firstName: 1 });
      }
    }

    return users;
  }

  /**
   * Get user by ID
   * organizationId is used to verify user belongs to organization (if provided)
   */
  async getUserById(
    userId: string, 
    organizationId?: string,
    requesterRole?: UserRole,
    requesterId?: string
  ): Promise<IUser> {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new BadRequestError('Invalid user ID');
    }

    const query: any = { _id: new mongoose.Types.ObjectId(userId) };
    if (organizationId) {
      query.organizationId = new mongoose.Types.ObjectId(organizationId);
    }

    const user = await User.findOne(query)
      .populate('supervisorId', 'firstName lastName email role department')
      .populate('createdBy', 'firstName lastName email');

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Role-based visibility check
    if (requesterRole === UserRole.HR) {
      // HR cannot see ADMIN or SUPER_ADMIN
      if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) {
        throw new ForbiddenError('HR Admin cannot access Company Admin profiles');
      }
    } else if (requesterRole === UserRole.SUPERVISOR) {
      // Manager can see any EMPLOYEE in the organization
      if (user.role !== UserRole.EMPLOYEE && user._id.toString() !== requesterId) {
        throw new ForbiddenError('Managers can only access Employee profiles');
      }
    } else if (requesterRole === UserRole.EMPLOYEE) {
      // Employees can only see themselves
      if (user._id.toString() !== requesterId) {
        throw new ForbiddenError('Employees can only access their own profile');
      }
    }

    return user;
  }

  /** Reset another user's local password from user management. */
  async resetUserPassword(
    userId: string,
    newPassword: string,
    requesterRole: UserRole,
    requesterId: string,
    organizationId?: string
  ): Promise<void> {
    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestError('Password must be at least 6 characters');
    }

    if (userId === requesterId) {
      throw new BadRequestError('Use your profile to change your own password');
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new BadRequestError('Invalid user ID');
    }

    const query: any = { _id: new mongoose.Types.ObjectId(userId) };
    if (requesterRole !== UserRole.SUPER_ADMIN) {
      if (!organizationId) {
        throw new ForbiddenError('Organization context is required');
      }
      query.organizationId = new mongoose.Types.ObjectId(organizationId);
    }

    const user = await User.findOne(query).select('+password');
    if (!user) {
      throw new NotFoundError('User not found');
    }

    if (user.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenError('Cannot reset a system admin password here');
    }

    if (user.authProvider === AuthProvider.MICROSOFT && !user.password) {
      throw new BadRequestError('Microsoft users must change their password through Microsoft');
    }

    user.password = newPassword;
    await user.save();
  }

  /**
   * Update user role (Super Admin/Admin only)
   */
  async updateUserRole(userId: string, newRole: UserRole): Promise<IUser> {
    const user = await User.findById(userId);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Prevent changing super admin role (extra safety)
    if (user.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenError('Cannot change super admin role');
    }

    user.role = newRole;
    await user.save();

    return user;
  }

  /**
   * Assign supervisor to user
   */
  async assignSupervisor(userId: string, supervisorId: string): Promise<IUser> {
    const user = await User.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    const supervisor = await User.findOne({
      _id: supervisorId,
      organizationId: user.organizationId // Must be in same organization
    });
    if (!supervisor) {
      throw new NotFoundError('Supervisor not found in this organization');
    }

    if (supervisor.role !== UserRole.SUPERVISOR && supervisor.role !== UserRole.ADMIN) {
      throw new BadRequestError('Assigned user must have supervisor or admin role');
    }

    user.supervisorId = new mongoose.Types.ObjectId(supervisorId);
    await user.save();

    return user;
  }

  /**
   * Update user information
   * requesterRole is used to enforce HR can only update Employees
   */
  async updateUser(
    userId: string, 
    updates: UpdateUserData, 
    requesterRole?: UserRole,
    requesterUserId?: string
  ): Promise<IUser> {
    const user = await User.findById(userId);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // HR can only update HR, SUPERVISOR, or EMPLOYEE roles (NOT Admin or Super Admin)
    if (requesterRole === UserRole.HR) {
      const allowedRolesForHR = [UserRole.HR, UserRole.SUPERVISOR, UserRole.EMPLOYEE];
      if (!allowedRolesForHR.includes(user.role as UserRole)) {
        throw new ForbiddenError('HR Admin cannot update Company Admin profiles');
      }
    }

    // Manager can only update EMPLOYEE roles in their team
    if (requesterRole === UserRole.SUPERVISOR) {
      if (user.role !== UserRole.EMPLOYEE) {
        throw new ForbiddenError('Managers can only update Employee profiles');
      }
      if (user.supervisorId?.toString() !== requesterUserId) {
        throw new ForbiddenError('Managers can only update their own team members');
      }
    }

    // Check if employeeId is being changed and if it's already in use within organization
    if (updates.employeeId && updates.employeeId !== user.employeeId) {
      const existing = await User.findOne({
        employeeId: updates.employeeId,
        organizationId: user.organizationId,
        isActive: true,
        _id: { $ne: user._id },
      });
      if (existing) {
        throw new ConflictError('Employee ID already in use in this organization');
      }
    }

    // Validate supervisor if being updated (must be in same organization)
    if (updates.supervisorId) {
      const supervisor = await User.findOne({
        _id: updates.supervisorId,
        organizationId: user.organizationId
      });
      if (!supervisor) {
        throw new NotFoundError('Supervisor not found in this organization');
      }
      if (supervisor.role !== UserRole.SUPERVISOR && supervisor.role !== UserRole.ADMIN) {
        throw new BadRequestError('Assigned supervisor must have supervisor or admin role');
      }
    }

    if (updates.department && updates.department !== user.department) {
      const dept = await Department.findOne({
        organizationId: user.organizationId,
        name: { $regex: `^${updates.department.trim()}$`, $options: 'i' },
      }).lean();
      if (dept) {
        if (!updates.leavePolicyId && dept.defaultLeavePolicyId) {
          updates.leavePolicyId = dept.defaultLeavePolicyId.toString();
        }
        if (!updates.payrollPolicyId && dept.defaultPayrollPolicyId) {
          updates.payrollPolicyId = dept.defaultPayrollPolicyId.toString();
        }
      }
    }

    if (updates.attendancePolicyId || updates.leavePolicyId || updates.payrollPolicyId) {
      await this.validatePolicyAssignments(user.organizationId!.toString(), updates);
    }

    if (updates.attendancePolicyId !== undefined) {
      user.attendancePolicyId = updates.attendancePolicyId
        ? new mongoose.Types.ObjectId(updates.attendancePolicyId)
        : undefined;
    }
    if (updates.leavePolicyId) {
      user.leavePolicyId = new mongoose.Types.ObjectId(updates.leavePolicyId);
    }
    if (updates.payrollPolicyId) {
      user.payrollPolicyId = new mongoose.Types.ObjectId(updates.payrollPolicyId);
    }
    if (updates.joiningDate) {
      user.joiningDate = new Date(updates.joiningDate);
    }

    const { attendancePolicyId, leavePolicyId, payrollPolicyId, joiningDate, ...rest } = updates;
    Object.assign(user, rest);
    await user.save();

    return user;
  }

  async updateUserStatus(
    userId: string,
    isActive: boolean,
    requesterRole?: UserRole,
    organizationId?: string
  ): Promise<IUser> {
    const user = await User.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    if (organizationId && user.organizationId?.toString() !== organizationId) {
      throw new ForbiddenError('User does not belong to your organization');
    }

    if (requesterRole === UserRole.HR) {
      const allowedRolesForHR = [UserRole.SUPERVISOR, UserRole.EMPLOYEE];
      if (!allowedRolesForHR.includes(user.role as UserRole)) {
        throw new ForbiddenError('HR Admin can only update status for Employees and Managers');
      }
    }

    if (user.role === UserRole.SUPER_ADMIN && requesterRole !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenError('Only System Admin can update Super Admin accounts');
    }

    if (isActive && !user.isActive && user.organizationId) {
      await this.assertCanAddActiveUser(user.organizationId.toString());
    }

    user.isActive = isActive;
    await user.save();
    return user;
  }

  async updateUserAttendancePolicy(
    userId: string,
    attendancePolicyId: string,
    organizationId: string
  ): Promise<IUser> {
    await this.validatePolicyAssignments(organizationId, { attendancePolicyId });
    const user = await User.findOne({ _id: userId, organizationId });
    if (!user) throw new NotFoundError('User not found');
    user.attendancePolicyId = new mongoose.Types.ObjectId(attendancePolicyId);
    await user.save();
    return user;
  }

  async updateUserPolicies(
    userId: string,
    organizationId: string,
    policies: {
      attendancePolicyId?: string | null;
      leavePolicyId?: string | null;
      payrollPolicyId?: string | null;
    }
  ): Promise<IUser> {
    await this.validatePolicyAssignments(organizationId, {
      attendancePolicyId: policies.attendancePolicyId ?? undefined,
      leavePolicyId: policies.leavePolicyId ?? undefined,
      payrollPolicyId: policies.payrollPolicyId ?? undefined,
    });

    const user = await User.findOne({ _id: userId, organizationId });
    if (!user) throw new NotFoundError('User not found');

    if (policies.attendancePolicyId !== undefined) {
      user.attendancePolicyId = policies.attendancePolicyId
        ? new mongoose.Types.ObjectId(policies.attendancePolicyId)
        : undefined;
    }
    if (policies.leavePolicyId !== undefined) {
      user.leavePolicyId = policies.leavePolicyId
        ? new mongoose.Types.ObjectId(policies.leavePolicyId)
        : undefined;
    }
    if (policies.payrollPolicyId !== undefined) {
      user.payrollPolicyId = policies.payrollPolicyId
        ? new mongoose.Types.ObjectId(policies.payrollPolicyId)
        : undefined;
    }

    await user.save();
    return user;
  }

  /**
   * Reset invitation state before resending invite email (fresh set-password link).
   */
  async resetInvitationForResend(userId: string, organizationId?: string): Promise<IUser> {
    const user = await User.findById(userId).select('+password');
    if (!user) {
      throw new NotFoundError('User not found');
    }
    if (
      organizationId &&
      user.organizationId?.toString() !== organizationId
    ) {
      throw new ForbiddenError('User does not belong to your organization');
    }
    if (user.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenError('Cannot resend invitation to super admin');
    }
    return resetUserInvitationState(user);
  }

  /**
   * Permanently delete user and related records (frees email for re-invite).
   */
  async deleteUser(
    userId: string,
    requesterUserId: string,
    requesterRole?: UserRole,
    organizationId?: string
  ): Promise<void> {
    const user = await User.findById(userId);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    if (user._id.toString() === requesterUserId.toString()) {
      throw new ForbiddenError('You cannot delete your own account');
    }

    if (user.role === UserRole.SUPER_ADMIN && requesterRole !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenError('Only Super Admin can delete System Admin users');
    }

    // Company Admin cannot delete other Admins (or themselves — already blocked).
    if (
      requesterRole === UserRole.ADMIN &&
      user.role === UserRole.ADMIN
    ) {
      throw new ForbiddenError('Admins cannot delete other admin accounts');
    }

    if (
      organizationId &&
      user.organizationId?.toString() !== organizationId
    ) {
      throw new ForbiddenError('User does not belong to your organization');
    }

    const deleted = await deleteUsersAndRelatedData([user._id]);
    if (deleted === 0) {
      throw new NotFoundError('User not found');
    }
  }

  /**
   * Get user statistics
   * organizationId filters stats to specific organization
   */
  async getUserStats(organizationId?: string): Promise<any> {
    const matchStage: any = {};
    if (organizationId) {
      matchStage.organizationId = new mongoose.Types.ObjectId(organizationId);
    }

    const stats = await User.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$role',
          count: { $sum: 1 },
        },
      },
    ]);

    const totalQuery: any = { isActive: true };
    const inactiveQuery: any = { isActive: false };
    if (organizationId) {
      totalQuery.organizationId = organizationId;
      inactiveQuery.organizationId = organizationId;
    }

    const totalUsers = await User.countDocuments(totalQuery);
    const totalInactive = await User.countDocuments(inactiveQuery);

    return {
      totalUsers,
      totalInactive,
      byRole: stats,
    };
  }
}

export default new UserService();
