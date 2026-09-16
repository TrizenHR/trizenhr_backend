import axios from 'axios';
import config from '../config';
import Organization from '../models/Organization';
import User, { UserRole } from '../models/User';
import { buildSetPasswordBaseUrl, buildDemoInviteLink } from '../utils/inviteUrl';
import { logger } from '../utils/logger';

interface OrganizationCreatedEmailInput {
  organizationId: string;
  organizationName: string;
  subdomain?: string;
  companyAdminEmail: string;
  companyAdminName?: string;
  createdByUserId?: string;
}

interface UserInvitationInput {
  email: string;
  role: UserRole;
  organizationId?: string;
  invitedByUserId?: string;
  firstName?: string;
  lastName?: string;
}

function formatAxiosError(error: unknown): Record<string, unknown> {
  if (axios.isAxiosError(error)) {
    return {
      message: error.message,
      status: error.response?.status,
      responseData: error.response?.data,
      url: error.config?.url,
    };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}

class EmailNotificationService {
  private isEmailConfigured(): boolean {
    return Boolean(config.emailService.url);
  }

  private warnEmailSkipped(flow: string): void {
    console.warn(
      `[EmailNotificationService] Skipping ${flow}: set EMAIL_SERVICE_URL`
    );
  }

  private getHeaders(userId?: string) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(config.emailService.authToken
        ? { 'X-Service-Auth': config.emailService.authToken }
        : {}),
      'X-Service-Name': 'trizenhr_backend',
    };

    if (config.emailService.authToken) {
      headers['X-Service-Auth'] = config.emailService.authToken;
    } else {
      logger.warn('EMAIL_SERVICE_AUTH_TOKEN is empty — email API will reject requests');
    }

    if (userId) {
      headers['X-User-Id'] = userId;
    }

    return headers;
  }

  private getInviteExpiryDate() {
    const now = new Date();
    now.setDate(now.getDate() + config.invitation.expiryDays);
    return now;
  }

  private async buildInviteLink(
    role: string,
    email: string,
    organizationId?: string
  ): Promise<string> {
    let subdomain: string | undefined;

    if (organizationId) {
      const organization = await Organization.findById(organizationId).select(
        'subdomain name'
      );
      subdomain = organization?.subdomain || undefined;
      logger.info('Resolved organization for invite link', {
        organizationId,
        organizationName: organization?.name,
        subdomain: subdomain || '(none — using platform URL)',
      });
    }

    const baseUrl = buildSetPasswordBaseUrl(subdomain);
    const url = new URL(baseUrl);
    url.searchParams.set('role', role);
    url.searchParams.set('email', email);

    if (organizationId) {
      url.searchParams.set('organizationId', organizationId);
    }

    if (subdomain) {
      url.searchParams.set('subdomain', subdomain);
    }

    const inviteLink = url.toString();
    logger.info('Built invitation link', { role, email, inviteLink });
    return inviteLink;
  }

  /** Map app roles to email-service role slugs (handles string values from API/DB). */
  private mapRoleForEmailService(
    role: UserRole | string
  ): 'company_admin' | 'hr_admin' | 'manager' | 'employee' {
    const normalized = String(role).trim().toLowerCase().replace(/\s+/g, '_');

    if (
      normalized === UserRole.ADMIN ||
      normalized === 'admin' ||
      normalized === 'company_admin' ||
      normalized === 'companyadmin'
    ) {
      return 'company_admin';
    }

    if (normalized === UserRole.HR || normalized === 'hr' || normalized === 'hr_admin') {
      return 'hr_admin';
    }

    if (
      normalized === UserRole.SUPERVISOR ||
      normalized === 'supervisor' ||
      normalized === 'manager'
    ) {
      return 'manager';
    }

    if (normalized === UserRole.EMPLOYEE || normalized === 'employee') {
      return 'employee';
    }

    if (normalized === UserRole.SUPER_ADMIN || normalized === 'super_admin') {
      return 'company_admin';
    }

    logger.warn('Unknown role for invitation email, defaulting to employee', { role });
    return 'employee';
  }

  private async resolveOrganizationName(organizationId?: string): Promise<string | undefined> {
    if (!organizationId) {
      return undefined;
    }

    const organization = await Organization.findById(organizationId).select('name');
    const name = organization?.name?.trim();
    if (!name) {
      logger.warn('Organization name not found for invitation email', { organizationId });
    }
    return name || undefined;
  }

  private async getDisplayName(userId?: string): Promise<string | undefined> {
    if (!userId) {
      return undefined;
    }

    const user = await User.findById(userId).select('firstName lastName email');
    if (!user) {
      return undefined;
    }

    return `${user.firstName} ${user.lastName}`.trim();
  }

  async sendOrganizationCreatedFlow(input: OrganizationCreatedEmailInput): Promise<void> {
    if (!this.isEmailConfigured()) {
      this.warnEmailSkipped('organization-created');
      return;
    }

    const endpoint = `${config.emailService.url}/api/v1/email/organization-created`;

    if (!config.emailService.authToken) {
      logger.warn('Organization-created email skipped: EMAIL_SERVICE_AUTH_TOKEN not set');
      return;
    }

    logger.info('Sending organization-created email', {
      endpoint,
      organizationName: input.organizationName,
      companyAdminEmail: input.companyAdminEmail,
    });

    const inviteExpiresAt = this.getInviteExpiryDate();
    const inviteLink = await this.buildInviteLink(
      'company_admin',
      input.companyAdminEmail,
      input.organizationId
    );
    const createdByName = await this.getDisplayName(input.createdByUserId);

    try {
      const response = await axios.post(
        endpoint,
        {
          organizationName: input.organizationName,
          subdomain: input.subdomain,
          companyAdminEmail: input.companyAdminEmail,
          companyAdminName: input.companyAdminName,
          companyAdminInviteLink: inviteLink,
          inviteExpiresAt: inviteExpiresAt.toISOString(),
          createdByName,
          platformName: 'TrizenHR',
          platformSupportEmail: config.emailService.platformSupportEmail,
          companyAdminRole: 'company_admin',
        },
        {
          headers: this.getHeaders(input.createdByUserId),
          timeout: 10000,
        }
      );

      logger.info('Organization-created email API OK', {
        status: response.status,
        organizationId: input.organizationId,
        companyAdminEmail: input.companyAdminEmail,
      });
    } catch (error) {
      logger.error('Organization-created email failed', formatAxiosError(error));
      throw error;
    }
  }

  async sendRoleInvitation(input: UserInvitationInput): Promise<void> {
    if (!this.isEmailConfigured()) {
      this.warnEmailSkipped('role-invitation');
      return;
    }

    const endpoint = `${config.emailService.url}/api/v1/email/role-invitation`;

    if (!config.emailService.authToken) {
      logger.warn('Role invitation skipped: EMAIL_SERVICE_AUTH_TOKEN not set');
      return;
    }

    if (input.role === UserRole.SUPER_ADMIN) {
      logger.info('Role invitation skipped for super_admin');
      return;
    }

    const expiresAt = this.getInviteExpiryDate();
    const mappedRole = this.mapRoleForEmailService(input.role);
    const organizationName = await this.resolveOrganizationName(input.organizationId);

    logger.info('Preparing role invitation email', {
      endpoint,
      to: input.email,
      appRole: input.role,
      emailServiceRole: mappedRole,
      organizationId: input.organizationId,
      organizationName: organizationName || '(missing — email will use generic copy)',
      expectedSender:
        mappedRole === 'company_admin'
          ? 'support@trizenhr.com'
          : 'support@trizenventures.com',
    });

    const inviteLink = await this.buildInviteLink(
      mappedRole,
      input.email,
      input.organizationId
    );

    const inviterName = await this.getDisplayName(input.invitedByUserId);
    const name = [input.firstName, input.lastName].filter(Boolean).join(' ').trim() || undefined;

    const payload = {
      email: input.email,
      role: mappedRole,
      inviteLink,
      expiresAt: expiresAt.toISOString(),
      organizationName,
      inviterName,
      platformName: 'TrizenHR',
      name,
      supportEmail: config.emailService.supportEmail,
    };

    try {
      const response = await axios.post(endpoint, payload, {
        headers: this.getHeaders(input.invitedByUserId),
        timeout: 10000,
      });

      logger.info('Role invitation email API OK', {
        status: response.status,
        to: input.email,
        mappedRole,
        organizationName,
      });
    } catch (error) {
      logger.error('Role invitation email API failed', {
        ...formatAxiosError(error),
        to: input.email,
        mappedRole,
      });
      throw error;
    }
  }

  async sendDemoInvitation(input: {
    email: string;
    role: UserRole;
    organizationId: string;
    companyName: string;
    rawToken: string;
    inviteExpiresAt: Date;
    demoAccessTtlDays: number;
    invitedByUserId: string;
    firstName?: string;
    lastName?: string;
    subdomain?: string;
  }): Promise<void> {
    if (!this.isEmailConfigured()) {
      this.warnEmailSkipped('demo-invitation');
      return;
    }

    const endpoint = `${config.emailService.url}/api/v1/email/demo-invitation`;

    if (!config.emailService.authToken) {
      logger.warn('Demo invitation skipped: EMAIL_SERVICE_AUTH_TOKEN not set');
      return;
    }

    const inviteLink = buildDemoInviteLink(input.rawToken, input.subdomain);
    const mappedRole = this.mapRoleForEmailService(input.role);
    const name = [input.firstName, input.lastName].filter(Boolean).join(' ').trim() || undefined;

    logger.info('Sending demo invitation email', {
      endpoint,
      to: input.email,
      companyName: input.companyName,
      inviteLink,
    });

    try {
      await axios.post(
        endpoint,
        {
          email: input.email,
          role: mappedRole,
          inviteLink,
          inviteExpiresAt: input.inviteExpiresAt.toISOString(),
          demoAccessTtlDays: input.demoAccessTtlDays,
          companyName: input.companyName,
          inviterName: 'Trizen HR Demo Team',
          platformName: 'TrizenHR Demo',
          name,
          supportEmail: config.emailService.platformSupportEmail,
        },
        {
          headers: this.getHeaders(input.invitedByUserId),
          timeout: 10000,
        }
      );

      logger.info('Demo invitation email API OK', { to: input.email });
    } catch (error) {
      logger.error('Demo invitation email failed', formatAxiosError(error));
      throw error;
    }
  }

  async sendPasswordReset(
    email: string,
    name: string,
    resetLink: string,
    expiresAt: Date
  ): Promise<void> {
    if (!this.isEmailConfigured()) {
      this.warnEmailSkipped('password-reset');
      return;
    }

    console.info('[EmailNotificationService] Triggering password-reset email', {
      email,
      emailServiceUrl: config.emailService.url,
    });

    try {
      await axios.post(
        `${config.emailService.url}/api/v1/email/password-reset`,
        {
          email,
          name,
          resetLink,
          expiresAt: expiresAt.toISOString(),
          platformName: 'TrizenHR',
        },
        {
          headers: this.getHeaders(),
          timeout: 5000,
        }
      );
      console.info('[EmailNotificationService] password-reset email accepted by email service', {
        email,
      });
    } catch (error: any) {
      const status = error?.response?.status;
      const detail = error?.response?.data;
      console.warn('Password reset email flow failed:', error?.message || error, {
        status,
        detail,
      });
    }
  }

  async sendBirthdayEmail(input: {
    email: string;
    name: string;
    organizationName?: string;
  }): Promise<void> {
    if (!this.isEmailConfigured()) {
      this.warnEmailSkipped('birthday');
      throw new Error('Email service not configured (EMAIL_SERVICE_URL)');
    }

    const endpoint = `${config.emailService.url}/api/v1/email/birthday`;

    if (!config.emailService.authToken) {
      logger.warn('Birthday email skipped: EMAIL_SERVICE_AUTH_TOKEN not set');
      throw new Error('Email service auth token not configured');
    }

    try {
      await axios.post(
        endpoint,
        {
          email: input.email,
          name: input.name,
          organizationName: input.organizationName,
          platformName: 'TrizenHR',
        },
        {
          headers: this.getHeaders(),
          timeout: 10000,
        }
      );
      logger.info('Birthday email API OK', { to: input.email });
    } catch (error) {
      logger.error('Birthday email failed', formatAxiosError(error));
      throw error;
    }
  }

  async sendAttendanceIrregularity(input: {
    recipients: string[];
    employeeName: string;
    employeeEmail?: string;
    organizationName?: string;
    date: string;
    status: string;
    details?: Record<string, string | number | undefined>;
  }): Promise<void> {
    if (!this.isEmailConfigured()) {
      this.warnEmailSkipped('attendance-irregularity');
      return;
    }

    if (!config.emailService.authToken) {
      logger.warn('Attendance irregularity email skipped: EMAIL_SERVICE_AUTH_TOKEN not set');
      return;
    }

    try {
      await axios.post(
        `${config.emailService.url}/api/v1/email/attendance-irregularity`,
        { ...input, platformName: 'TrizenHR' },
        { headers: this.getHeaders(), timeout: 10000 }
      );
      logger.info('Attendance irregularity email API OK', {
        recipients: input.recipients,
        employeeName: input.employeeName,
        date: input.date,
        status: input.status,
      });
    } catch (error) {
      logger.error('Attendance irregularity email failed', formatAxiosError(error));
      throw error;
    }
  }

  /**
   * Send OTP verification code email for trial registration
   */
  async sendOtpEmail(email: string, otp: string, name?: string): Promise<void> {
    if (!this.isEmailConfigured()) {
      this.warnEmailSkipped('OTP email');
      logger.warn(`[EmailNotificationService] OTP email skipped (EMAIL_SERVICE_URL not set). OTP for ${email}: ${otp}`);
      return;
    }

    const endpoint = `${config.emailService.url}/api/v1/email/send-otp`;

    try {
      await axios.post(
        endpoint,
        {
          email,
          name: name || email,
          otp,
          expiresInMinutes: 10,
          platformName: 'TrizenHR',
        },
        {
          headers: this.getHeaders(),
          timeout: 10000,
        }
      );
      logger.info('[EmailNotificationService] OTP email sent', { to: email });
    } catch (error) {
      logger.error('[EmailNotificationService] OTP email failed', formatAxiosError(error));
      throw error;
    }
  }
}


export function logEmailServiceConfigAtStartup(): void {
  const urlSet = Boolean(config.emailService.url);
  const tokenSet = Boolean(config.emailService.authToken);
  const configured = urlSet && tokenSet;

  console.info('[EmailNotificationService] Startup config', {
    configured,
    emailServiceUrl: urlSet ? config.emailService.url : '(missing EMAIL_SERVICE_URL)',
    authTokenSet: tokenSet,
    supportEmail: config.emailService.supportEmail,
    invitationBaseUrl: config.invitation.baseUrl,
  });

  if (!configured) {
    console.warn(
      '[EmailNotificationService] Emails are DISABLED until EMAIL_SERVICE_URL and EMAIL_SERVICE_AUTH_TOKEN are set in CapRover (token must match email service SERVICE_AUTH_TOKEN)'
    );
  }
}

export default new EmailNotificationService();
