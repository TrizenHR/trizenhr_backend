import { startOfDay, endOfDay } from 'date-fns';
import Attendance, { AttendanceStatus } from '../models/Attendance';
import Leave, { LeaveStatus } from '../models/Leave';
import User from '../models/User';
import { IAttendancePolicy, PolicyDayType } from '../models/AttendancePolicy';
import {
  endOfOrgCalendarDay,
  getOrganizationTimezone,
  getOrgCalendarDate,
  parseOrgTimeOnDate,
  startOfOrgCalendarDay,
} from '../utils/timezone';
import {
  dateToWeekDay,
  resolveDayRule,
} from '../utils/attendancePolicyValidation';
import { getNonWorkingHolidayDateKeys, toDateKey } from '../utils/workingDays';
import Holiday from '../models/Holiday';
import { resolveUserAttendancePolicy } from '../utils/resolveUserAttendancePolicy';
import { loadPolicyShiftTiming } from '../utils/policyShiftTiming';

export enum ResolvedAttendanceStatus {
  NOT_JOINED = 'not_joined',
  HOLIDAY = 'holiday',
  WEEKLY_OFF = 'weekly_off',
  ON_LEAVE = 'on_leave',
  ABSENT = 'absent',
  PRESENT = 'present',
  HALF_DAY = 'half_day',
  LATE = 'late',
  PRESENT_WITH_LATE = 'present_with_late',
}

export function mapResolvedToAttendanceStatus(
  status: ResolvedAttendanceStatus
): AttendanceStatus {
  switch (status) {
    case ResolvedAttendanceStatus.PRESENT:
      return AttendanceStatus.PRESENT;
    case ResolvedAttendanceStatus.PRESENT_WITH_LATE:
      return AttendanceStatus.PRESENT_WITH_LATE;
    case ResolvedAttendanceStatus.LATE:
      return AttendanceStatus.LATE;
    case ResolvedAttendanceStatus.HALF_DAY:
      return AttendanceStatus.HALF_DAY;
    case ResolvedAttendanceStatus.ABSENT:
      return AttendanceStatus.ABSENT;
    case ResolvedAttendanceStatus.ON_LEAVE:
      return AttendanceStatus.ON_LEAVE;
    case ResolvedAttendanceStatus.WEEKLY_OFF:
      return AttendanceStatus.WEEKLY_OFF;
    case ResolvedAttendanceStatus.HOLIDAY:
      return AttendanceStatus.HOLIDAY;
    case ResolvedAttendanceStatus.NOT_JOINED:
      return AttendanceStatus.NOT_JOINED;
    default:
      return AttendanceStatus.PRESENT;
  }
}

export type ResolvedAttendance = {
  employeeId: string;
  date: string;
  dayType: PolicyDayType;
  startTime?: string;
  endTime?: string;
  expectedHours?: number;
  graceMinutes?: number;
  isWorkingDay: boolean;
  isWeeklyOff: boolean;
  isHoliday: boolean;
  hasLeave: boolean;
  attendanceStatus: ResolvedAttendanceStatus;
  policyId?: string;
  policyName?: string;
  shiftId?: string;
  checkIn?: Date;
  checkOut?: Date;
  workingHours?: number;
};

function getEffectiveJoinDate(user: { joiningDate?: Date; createdAt: Date }): Date {
  return startOfDay(user.joiningDate ?? user.createdAt);
}

function halfDayThreshold(expectedHours: number): number {
  return expectedHours / 2;
}

async function resolveDayRuleForUser(
  policy: IAttendancePolicy | null,
  date: Date
) {
  if (!policy) {
    return {
      dayType: PolicyDayType.FULL_DAY,
      startTime: '09:00',
      endTime: '18:00',
      expectedHours: 8,
      graceMinutes: 15,
    };
  }

  const shift = await loadPolicyShiftTiming(policy);
  const weekDay = dateToWeekDay(date);
  return resolveDayRule(policy.weekRules, shift, weekDay);
}

export class AttendanceResolver {
  async resolve(employeeId: string, dateInput: Date): Promise<ResolvedAttendance> {
    const user = await User.findById(employeeId).lean();
    if (!user || !user.organizationId) {
      throw new Error('Employee not found');
    }

    const organizationId = user.organizationId.toString();
    const organizationTimezone = await getOrganizationTimezone(organizationId);
    const organizationDate = getOrgCalendarDate(dateInput, organizationTimezone);
    const date = startOfOrgCalendarDay(organizationDate, organizationTimezone);
    const dayEnd = endOfOrgCalendarDay(organizationDate, organizationTimezone);
    const joinDate = getEffectiveJoinDate(user);

    const policy = await resolveUserAttendancePolicy(user);
    const dayRule = await resolveDayRuleForUser(policy, date);

    const holidayKeys = await getNonWorkingHolidayDateKeys(organizationId, date, date);
    const isHoliday = holidayKeys.has(toDateKey(date));

    const isWeeklyOff = dayRule.dayType === PolicyDayType.WEEKLY_OFF;
    const isWorkingDay =
      !isWeeklyOff && !isHoliday && date >= joinDate;

    const approvedLeave = await Leave.findOne({
      userId: employeeId,
      organizationId,
      status: LeaveStatus.APPROVED,
      startDate: { $lte: dayEnd },
      endDate: { $gte: date },
    }).lean();

    const hasLeave = Boolean(approvedLeave);

    const record = await Attendance.findOne({
      userId: employeeId,
      organizationId,
      date: { $gte: date, $lte: dayEnd },
    }).lean();

    const base: ResolvedAttendance = {
      employeeId,
      date: date.toISOString(),
      dayType: dayRule.dayType,
      startTime: dayRule.startTime,
      endTime: dayRule.endTime,
      expectedHours: dayRule.expectedHours,
      graceMinutes: dayRule.graceMinutes,
      isWorkingDay,
      isWeeklyOff,
      isHoliday,
      hasLeave,
      attendanceStatus: ResolvedAttendanceStatus.ABSENT,
      policyId: policy?._id?.toString(),
      policyName: policy?.policyName,
      shiftId: policy?.shiftId?.toString(),
      checkIn: record?.checkIn,
      checkOut: record?.checkOut,
      workingHours: record?.workingHours,
    };

    if (date < joinDate) {
      return { ...base, attendanceStatus: ResolvedAttendanceStatus.NOT_JOINED, isWorkingDay: false };
    }

    if (isHoliday) {
      return { ...base, attendanceStatus: ResolvedAttendanceStatus.HOLIDAY, isWorkingDay: false };
    }

    if (isWeeklyOff) {
      return { ...base, attendanceStatus: ResolvedAttendanceStatus.WEEKLY_OFF, isWorkingDay: false };
    }

    if (hasLeave) {
      return { ...base, attendanceStatus: ResolvedAttendanceStatus.ON_LEAVE, isWorkingDay: false };
    }

    if (!record?.checkIn) {
      return { ...base, attendanceStatus: ResolvedAttendanceStatus.ABSENT };
    }

    const workedHours = record.workingHours ?? 0;
    const expected = dayRule.expectedHours ?? 8;
    const graceMinutes = dayRule.graceMinutes ?? 15;
    const workStart = dayRule.startTime
      ? parseOrgTimeOnDate(date, dayRule.startTime, organizationTimezone)
      : parseOrgTimeOnDate(date, '09:00', organizationTimezone);
    const graceEnd = new Date(workStart.getTime() + graceMinutes * 60 * 1000);
    const checkInTime = new Date(record.checkIn);
    const isLate = checkInTime > graceEnd;

    if (dayRule.dayType === PolicyDayType.HALF_DAY) {
      if (workedHours >= expected * 0.9 || (record.checkIn && record.checkOut && workedHours >= expected * 0.75)) {
        return {
          ...base,
          attendanceStatus: isLate
            ? ResolvedAttendanceStatus.PRESENT_WITH_LATE
            : ResolvedAttendanceStatus.PRESENT,
        };
      }
      if (workedHours >= halfDayThreshold(expected)) {
        return { ...base, attendanceStatus: ResolvedAttendanceStatus.HALF_DAY };
      }
      return {
        ...base,
        attendanceStatus: isLate ? ResolvedAttendanceStatus.LATE : ResolvedAttendanceStatus.ABSENT,
      };
    }

    if (workedHours >= expected * 0.9 || (record.checkIn && record.checkOut && workedHours >= expected * 0.75)) {
      return {
        ...base,
        attendanceStatus: isLate
          ? ResolvedAttendanceStatus.PRESENT_WITH_LATE
          : ResolvedAttendanceStatus.PRESENT,
      };
    }

    if (workedHours >= halfDayThreshold(expected)) {
      return {
        ...base,
        attendanceStatus: isLate ? ResolvedAttendanceStatus.LATE : ResolvedAttendanceStatus.HALF_DAY,
      };
    }

    if (isLate) {
      return { ...base, attendanceStatus: ResolvedAttendanceStatus.LATE };
    }

    if (record.status === AttendanceStatus.LATE) {
      return { ...base, attendanceStatus: ResolvedAttendanceStatus.LATE };
    }

    return { ...base, attendanceStatus: ResolvedAttendanceStatus.PRESENT };
  }

  async resolveToday(employeeId: string): Promise<ResolvedAttendance> {
    return this.resolve(employeeId, startOfDay(new Date()));
  }
}

export const attendanceResolver = new AttendanceResolver();

export async function isDateHoliday(organizationId: string, date: Date): Promise<boolean> {
  const keys = await getNonWorkingHolidayDateKeys(organizationId, date, date);
  return keys.has(toDateKey(date));
}

export async function getHolidayName(organizationId: string, date: Date): Promise<string | null> {
  const holiday = await Holiday.findOne({
    organizationId,
    date: { $gte: startOfDay(date), $lte: endOfDay(date) },
  }).lean();
  return holiday?.name ?? null;
}
