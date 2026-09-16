import User, { UserRole } from '../models/User';
import { attendanceResolver } from '../services/attendanceResolver';
import attendanceIrregularityNotificationService from '../services/attendanceIrregularityNotificationService';
import { getOrganizationTimezone, getOrgCalendarDate, startOfOrgCalendarDay } from '../utils/timezone';
import { logger } from '../utils/logger';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
let dailyIntervalHandle: ReturnType<typeof setInterval> | null = null;
let nextRunTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

function getRunHour(): number {
  const parsed = Number.parseInt(process.env.ATTENDANCE_IRREGULARITY_EMAIL_HOUR || '20', 10);
  return Number.isNaN(parsed) ? 20 : Math.min(23, Math.max(0, parsed));
}

function msUntilNextRun(reference = new Date()): number {
  const next = new Date(reference);
  next.setHours(getRunHour(), 0, 0, 0);
  if (next <= reference) next.setDate(next.getDate() + 1);
  return next.getTime() - reference.getTime();
}

export async function runDailyAttendanceIrregularityScan(): Promise<void> {
  const organizationIds = await User.distinct('organizationId', {
    isActive: true,
    role: { $in: [UserRole.EMPLOYEE, UserRole.SUPERVISOR] },
  });

  for (const organizationId of organizationIds) {
    const organizationIdString = organizationId.toString();
    const timezone = await getOrganizationTimezone(organizationIdString);
    const today = getOrgCalendarDate(new Date(), timezone);
    const date = startOfOrgCalendarDay(today, timezone);
    const employees = await User.find({
      organizationId,
      isActive: true,
      role: { $in: [UserRole.EMPLOYEE, UserRole.SUPERVISOR] },
    }).select('_id').lean();

    for (const employee of employees) {
      try {
        const resolved = await attendanceResolver.resolve(employee._id.toString(), date);
        await attendanceIrregularityNotificationService.notify(resolved, undefined, 'daily_scan');
      } catch (error: any) {
        logger.error('Attendance irregularity scan failed for employee', {
          employeeId: employee._id.toString(),
          organizationId: organizationIdString,
          error: error?.message || String(error),
        });
      }
    }
  }
}

export function startAttendanceIrregularityEmailScheduler(): void {
  if (process.env.ATTENDANCE_IRREGULARITY_EMAIL_SCHEDULER === 'false') return;

  nextRunTimeoutHandle = setTimeout(() => {
    void runDailyAttendanceIrregularityScan().catch((error) => {
      logger.error('Daily attendance irregularity scan failed', { error: String(error) });
    });
    dailyIntervalHandle = setInterval(() => {
      void runDailyAttendanceIrregularityScan().catch((error) => {
        logger.error('Daily attendance irregularity scan failed', { error: String(error) });
      });
    }, MS_PER_DAY);
  }, msUntilNextRun());

  logger.info('Attendance irregularity email scheduler started', { runHour: getRunHour() });
}

export function stopAttendanceIrregularityEmailScheduler(): void {
  if (nextRunTimeoutHandle) clearTimeout(nextRunTimeoutHandle);
  if (dailyIntervalHandle) clearInterval(dailyIntervalHandle);
  nextRunTimeoutHandle = null;
  dailyIntervalHandle = null;
}