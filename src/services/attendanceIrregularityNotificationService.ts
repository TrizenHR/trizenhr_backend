import AttendanceIrregularityNotification from '../models/AttendanceIrregularityNotification';
import Organization from '../models/Organization';
import User, { UserRole } from '../models/User';
import { ResolvedAttendanceStatus, ResolvedAttendance } from './attendanceResolver';
import emailNotificationService from './emailNotificationService';
import {
  getOrgCalendarDate,
  getOrganizationTimezone,
  parseOrgTimeOnDate,
} from '../utils/timezone';

const NOTIFIABLE_STATUSES = new Set<ResolvedAttendanceStatus>([
  ResolvedAttendanceStatus.ABSENT,
  ResolvedAttendanceStatus.HALF_DAY,
  ResolvedAttendanceStatus.LATE,
  ResolvedAttendanceStatus.PRESENT_WITH_LATE,
]);

export type AttendanceNotificationTrigger = 'check_in' | 'check_out' | 'daily_scan';

function displayName(user: { firstName?: string; lastName?: string; email: string }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email;
}

class AttendanceIrregularityNotificationService {
  async notify(
    resolved: ResolvedAttendance,
    attendance?: Record<string, any>,
    trigger: AttendanceNotificationTrigger = 'daily_scan'
  ): Promise<void> {
    if (!NOTIFIABLE_STATUSES.has(resolved.attendanceStatus)) return;

    let notificationType: string;
    if (trigger === 'check_in') {
      if (resolved.attendanceStatus !== ResolvedAttendanceStatus.LATE &&
          resolved.attendanceStatus !== ResolvedAttendanceStatus.PRESENT_WITH_LATE) return;
      notificationType = 'late_check_in';
    } else if (trigger === 'check_out') {
      if (resolved.attendanceStatus !== ResolvedAttendanceStatus.LATE &&
          resolved.attendanceStatus !== ResolvedAttendanceStatus.HALF_DAY) return;
      notificationType = resolved.attendanceStatus === ResolvedAttendanceStatus.HALF_DAY
        ? 'half_day'
        : 'insufficient_hours';
    } else {
      if (resolved.attendanceStatus !== ResolvedAttendanceStatus.ABSENT) return;
      notificationType = 'absent';
    }

    const employee = await User.findById(resolved.employeeId)
      .select('organizationId firstName lastName email supervisorId role department')
      .lean();
    if (!employee?.organizationId) return;

    const recipients = await User.find({
      organizationId: employee.organizationId,
      isActive: true,
      $or: [
        { role: UserRole.ADMIN },
        ...(employee.supervisorId ? [{ _id: employee.supervisorId }] : []),
        ...(!employee.supervisorId && employee.department
          ? [{ role: UserRole.SUPERVISOR, department: employee.department }]
          : []),
      ],
    }).select('email firstName lastName').lean();

    const organization = await Organization.findById(employee.organizationId).select('name').lean();
    const timezone = await getOrganizationTimezone(employee.organizationId.toString());
    const date = getOrgCalendarDate(new Date(resolved.date), timezone);
    const checkInTime = resolved.checkIn
      ? new Intl.DateTimeFormat('en-IN', {
          timeZone: timezone,
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(resolved.checkIn))
      : undefined;
    const scheduledStart = resolved.startTime || '09:00';
    const lateByMinutes = resolved.checkIn
      ? Math.max(
          0,
          Math.round(
            (new Date(resolved.checkIn).getTime() -
              parseOrgTimeOnDate(resolved.date, scheduledStart, timezone).getTime()) /
              60000
          )
        )
      : 0;
    const lateBy = lateByMinutes > 0
      ? `${Math.floor(lateByMinutes / 60)}h ${lateByMinutes % 60}m`
      : undefined;
    const details = {
      checkInTime,
      lateBy,
      checkOut: resolved.checkOut?.toISOString(),
      workingHours: resolved.workingHours,
      expectedHours: resolved.expectedHours,
      scheduledStart,
      checkInLocation: attendance?.checkInLocationLabel,
    };

    for (const recipient of recipients) {
      const alreadySent = await AttendanceIrregularityNotification.exists({
        organizationId: employee.organizationId,
        employeeId: employee._id,
        recipientId: recipient._id,
        date: new Date(resolved.date),
        notificationType,
      });
      if (alreadySent) continue;

      await emailNotificationService.sendAttendanceIrregularity({
        recipients: [recipient.email],
        employeeName: displayName(employee),
        employeeEmail: employee.email,
        organizationName: organization?.name,
        date,
        status: notificationType,
        details,
      });

      try {
        await AttendanceIrregularityNotification.create({
          organizationId: employee.organizationId,
          employeeId: employee._id,
          recipientId: recipient._id,
          date: new Date(resolved.date),
          status: resolved.attendanceStatus,
          notificationType,
        });
      } catch (error: any) {
        if (error?.code !== 11000) throw error;
      }
    }
  }
}

export default new AttendanceIrregularityNotificationService();