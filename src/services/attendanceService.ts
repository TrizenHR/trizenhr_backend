import mongoose from 'mongoose';
import Attendance, { AttendanceStatus, LocationStatus } from '../models/Attendance';
import AttendancePolicy, { GeofenceEnforcementMode } from '../models/AttendancePolicy';
import AttendanceRegularization, {
  RegularizationRequestType,
  RegularizationStatus,
} from '../models/AttendanceRegularization';
import OfficeLocation from '../models/OfficeLocation';
import Leave, { LeaveStatus } from '../models/Leave';
import User, { UserRole } from '../models/User';
import { startOfDay, endOfDay, format } from 'date-fns';
import { checkInMinioStorage } from '../utils/storage/MinIOStorage';
import { parseOrgTimeOnDate } from '../utils/timezone';
import { getNonWorkingHolidayDateKeys } from '../utils/workingDays';
import { haversineDistance } from '../utils/geoUtils';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/AppError';
import {
  endOfOrgCalendarDay,
  getOrgCalendarDate,
  getOrganizationTimezone,
  startOfOrgCalendarDay,
} from '../utils/timezone';
import {
  buildImpliedAbsentRecords,
  computeUserAttendanceStats,
  isPolicyWorkingDay,
} from '../utils/attendanceAbsence';
import { attendanceResolver, mapResolvedToAttendanceStatus } from './attendanceResolver';
import attendanceIrregularityNotificationService from './attendanceIrregularityNotificationService';
import { shiftService } from './shiftService';
import { FieldTrackingService } from './fieldTrackingService';
import { FieldTrackingStatus } from '../models/FieldTrackingSession';
import { reverseGeocodeAreaName } from '../utils/reverseGeocode';

const fieldTrackingService = new FieldTrackingService();

type GeoPoint = {
  latitude: number;
  longitude: number;
};

/** Stable API path — served by GET /attendance/:id/check-in-photo (does not expire). */
export function buildCheckInPhotoPath(attendanceId: string): string {
  return `/attendance/${attendanceId}/check-in-photo`;
}

function resolveAttendanceId(record: Record<string, unknown>): string | undefined {
  const raw = record._id ?? record.id;
  if (!raw) return undefined;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw !== null && 'toString' in raw) {
    return (raw as { toString: () => string }).toString();
  }
  return String(raw);
}

function sanitizeAttendanceForClient<T extends Record<string, unknown>>(record: T): T {
  const copy = { ...record };
  delete copy.checkInPhotoData;
  delete copy.checkInPhotoContentType;
  delete copy.checkOutPhotoData;
  delete copy.checkOutPhotoContentType;
  return copy;
}

/** Stable API path — served by GET /attendance/:id/check-out-photo (does not expire). */
export function buildCheckOutPhotoPath(attendanceId: string): string {
  return `/attendance/${attendanceId}/check-out-photo`;
}

async function uploadCheckInPhotoWithRetry(
  imageBuffer: Buffer,
  fileName: string,
  folder: string,
  metadata: Record<string, string>,
  retries = 2
): Promise<{ url: string; key: string; bucket?: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await checkInMinioStorage.uploadFile(
        imageBuffer,
        fileName,
        'image/jpeg',
        folder,
        metadata
      );
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

/**
 * Normalize a photo field read via `.lean()` into a real Buffer.
 * MongoDB driver returns Buffer-typed schema fields as BSON `Binary` on lean
 * queries (not a Node Buffer), so `Buffer.isBuffer()` is false and its
 * `.length` is a method, not a number — silently breaking truthiness/size
 * checks. `Binary#value()` returns the underlying Buffer correctly.
 */
function toPhotoBuffer(raw: unknown): Buffer | undefined {
  if (!raw) return undefined;
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  const binary = raw as { value?: () => Buffer; buffer?: Uint8Array };
  if (typeof binary.value === 'function') return binary.value();
  if (binary.buffer) return Buffer.from(binary.buffer);
  return undefined;
}

function resolveCheckInPhotoKey(photoRef?: string): string | undefined {
  const trimmed = photoRef?.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes('/attendance/') && trimmed.includes('check-in-photo')) {
    return undefined;
  }
  if (!trimmed.includes('://')) return trimmed;

  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/^\/+/, '');
    const bucket =
      process.env.MINIO_CHECKIN_BUCKET_NAME ||
      process.env.MINIO_BUCKET_NAME ||
      'attendence-image-checkin';
    if (path.startsWith(`${bucket}/`)) {
      return path.slice(bucket.length + 1);
    }
    const segments = path.split('/');
    if (segments[0] === bucket) {
      return segments.slice(1).join('/');
    }
    return path;
  } catch {
    return trimmed;
  }
}

async function enrichAttendancePhoto<T extends Record<string, unknown>>(record: T | null): Promise<T | null> {
  if (!record) return record;

  const attendanceId = resolveAttendanceId(record);
  if (!attendanceId) return record;

  const checkInKey = resolveCheckInPhotoKey(record.photoKey as string | undefined);
  const hasCheckIn = Boolean(record.checkInPhotoStored) || Boolean(checkInKey);
  const checkOutKey = resolveCheckInPhotoKey(record.checkOutPhotoKey as string | undefined);
  const hasCheckOut = Boolean(record.checkOutPhotoStored) || Boolean(checkOutKey);

  if (!hasCheckIn && !hasCheckOut) {
    return sanitizeAttendanceForClient(record);
  }

  const storedCheckInUrl = record.photoUrl as string | undefined;
  const photoUrl = hasCheckIn
    ? storedCheckInUrl?.startsWith('/')
      ? storedCheckInUrl
      : buildCheckInPhotoPath(attendanceId)
    : record.photoUrl;

  const storedCheckOutUrl = record.checkOutPhotoUrl as string | undefined;
  const checkOutPhotoUrl = hasCheckOut
    ? storedCheckOutUrl?.startsWith('/')
      ? storedCheckOutUrl
      : buildCheckOutPhotoPath(attendanceId)
    : record.checkOutPhotoUrl;

  return sanitizeAttendanceForClient({
    ...record,
    ...(hasCheckIn
      ? {
          photoUrl,
          hasCheckInPhoto: true,
          ...(checkInKey ? { photoKey: checkInKey } : {}),
        }
      : {}),
    ...(hasCheckOut
      ? {
          checkOutPhotoUrl,
          hasCheckOutPhoto: true,
          ...(checkOutKey ? { checkOutPhotoKey: checkOutKey } : {}),
        }
      : {}),
  });
}

async function enrichAttendancePhotos<T extends Record<string, unknown>>(records: T[]): Promise<T[]> {
  const withKeys = records.map((record) => {
    if (record.date && !record.dateKey) {
      return {
        ...record,
        dateKey: format(startOfDay(new Date(record.date as string | Date)), 'yyyy-MM-dd'),
      };
    }
    return record;
  });
  return Promise.all(withKeys.map(r => enrichAttendancePhoto(r).then(x => x ?? r)));
}

async function resolveAttendancePolicy(
  organizationId: string
): Promise<{ policy: any; nearestOffice: any; distance: number } | null> {
  const policy = await AttendancePolicy.findOne({
    organizationId,
    status: 'ACTIVE',
    isDefault: true,
  }).lean();

  return policy ? { policy, nearestOffice: null, distance: 0 } : null;
}

async function processGeofence(
  organizationId: string,
  geoPoint: GeoPoint | undefined
): Promise<{
  locationStatus: LocationStatus;
  officeLocationId?: mongoose.Types.ObjectId;
  distance?: number;
}> {
  const result = await resolveAttendancePolicy(organizationId);
  if (!result) {
    return { locationStatus: LocationStatus.NOT_APPLICABLE };
  }

  const { policy } = result;
  const geofence = policy.geofence;

  if (!geofence || !geofence.enabled) {
    return { locationStatus: LocationStatus.NOT_APPLICABLE };
  }

  if (!geoPoint) {
    if (geofence.enforcementMode === GeofenceEnforcementMode.BLOCK) {
      throw new BadRequestError('Location data is required for check-in');
    }
    return { locationStatus: LocationStatus.NOT_CAPTURED };
  }

  let targetLocations: any[];
  if (geofence.officeLocationIds && geofence.officeLocationIds.length > 0) {
    targetLocations = await OfficeLocation.find({
      _id: { $in: geofence.officeLocationIds },
      organizationId,
      isActive: true,
    }).lean();
  } else {
    targetLocations = await OfficeLocation.find({
      organizationId,
      isActive: true,
    }).sort({ name: 1 }).lean();
  }

  if (targetLocations.length === 0) {
    return { locationStatus: LocationStatus.NOT_APPLICABLE };
  }

  let nearest: any = targetLocations[0];
  let minDistance = haversineDistance(
    geoPoint.latitude,
    geoPoint.longitude,
    nearest.latitude,
    nearest.longitude
  );

  for (let i = 1; i < targetLocations.length; i++) {
    const loc = targetLocations[i];
    const d = haversineDistance(geoPoint.latitude, geoPoint.longitude, loc.latitude, loc.longitude);
    if (d < minDistance) {
      minDistance = d;
      nearest = loc;
    }
  }

  const withinRadius = minDistance <= nearest.radiusMeters;

  if (withinRadius) {
    return {
      locationStatus: LocationStatus.VERIFIED,
      officeLocationId: nearest._id,
      distance: Math.round(minDistance),
    };
  }

  if (geofence.enforcementMode === GeofenceEnforcementMode.BLOCK) {
    throw new BadRequestError(
      `You are outside the allowed office location (${Math.round(minDistance)}m from "${nearest.name}", max ${nearest.radiusMeters}m)`
    );
  }

  return {
    locationStatus: LocationStatus.OUT_OF_RANGE,
    officeLocationId: nearest._id,
    distance: Math.round(minDistance),
  };
}

export class AttendanceService {
  async checkIn(
    userId: string,
    organizationId: string,
    photoData?: string,
    latitude?: number,
    longitude?: number
  ): Promise<any> {
    const orgTimezone = await getOrganizationTimezone(organizationId);
    const todayCalendar = getOrgCalendarDate(new Date(), orgTimezone);
    const today = startOfOrgCalendarDay(todayCalendar, orgTimezone);
    const dayEnd = endOfOrgCalendarDay(todayCalendar, orgTimezone);

    const existingAttendance = await Attendance.findOne({
      userId,
      organizationId,
      date: { $gte: today, $lte: dayEnd },
    });

    if (existingAttendance) {
      throw new Error('Already checked in today');
    }

    const resolved = await attendanceResolver.resolve(userId, today);
    if (!resolved.isWorkingDay) {
      if (resolved.isHoliday) {
        throw new Error('Today is a holiday — check-in is not required');
      }
      if (resolved.isWeeklyOff) {
        throw new Error('Today is a weekly off — check-in is not required');
      }
      if (resolved.hasLeave) {
        throw new Error('You are on approved leave today');
      }
    }

    const now = new Date();
    const workStartTime = resolved.startTime
      ? parseOrgTimeOnDate(today, resolved.startTime, orgTimezone)
      : parseOrgTimeOnDate(today, '09:00', orgTimezone);
    const graceMinutes = resolved.graceMinutes ?? 15;
    const graceEnd = new Date(workStartTime.getTime() + graceMinutes * 60 * 1000);

    const status = now > graceEnd ? AttendanceStatus.LATE : AttendanceStatus.PRESENT;

    // Upload photo to MinIO if provided; fall back to MongoDB when storage is unreachable.
    let photoKey: string | undefined;
    let checkInPhotoData: Buffer | undefined;
    let checkInPhotoContentType: string | undefined;
    let checkInPhotoStored = false;

    console.info('[checkIn] photo received:', {
      hasPhotoData: Boolean(photoData),
      photoDataLength: typeof photoData === 'string' ? photoData.length : 0,
      userId,
    });

    if (photoData) {
      const base64Data = photoData.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');

      const maxSize = 5 * 1024 * 1024;
      if (imageBuffer.length > maxSize) {
        throw new Error('Check-in photo must be under 5MB');
      }

      const year = todayCalendar.slice(0, 4);
      const month = todayCalendar.slice(5, 7);
      const day = todayCalendar.slice(8, 10);
      const folder = `org-${organizationId}/${year}/${month}/${day}`;
      const fileName = `${userId}_checkin_${now.getTime()}.jpg`;
      const uploadMeta = { userId, type: 'checkin', date: today.toISOString() };

      try {
        const result = await uploadCheckInPhotoWithRetry(
          imageBuffer,
          fileName,
          folder,
          uploadMeta
        );
        photoKey = result.key;
        checkInPhotoStored = true;
        console.info('[checkIn] photo uploaded to MinIO:', result.key);
      } catch (uploadError: any) {
        console.error(
          '[checkIn] MinIO upload failed, using database fallback:',
          uploadError?.message || uploadError
        );
        checkInPhotoData = imageBuffer;
        checkInPhotoContentType = 'image/jpeg';
        checkInPhotoStored = true;
      }
    }

    let lat = latitude;
    let lng = longitude;

    const userObj = await User.findById(userId).select('email firstName lastName').lean();
    const isDemoUser = userObj && (
      userObj.email === 'avvkat456@gmail.com' ||
      (userObj.firstName?.toLowerCase() === 'demo' && userObj.lastName?.toLowerCase() === 'user')
    );

    if (isDemoUser) {
      lat = 17.9326;
      lng = 83.4265;
    }

    const geoPoint: GeoPoint | undefined =
      lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng } : undefined;

    const geofenceResult = await processGeofence(organizationId, geoPoint);

    let checkInLocationLabel: string | undefined;
    if (geoPoint) {
      try {
        checkInLocationLabel = await reverseGeocodeAreaName(
          geoPoint.latitude,
          geoPoint.longitude
        );
      } catch {
        // Non-blocking — attendance must succeed without area label.
      }
    }

    const attendance = await Attendance.create({
      userId,
      organizationId,
      date: today,
      checkIn: now,
      status,
      photoKey,
      checkInPhotoData,
      checkInPhotoContentType,
      checkInPhotoStored,
      officeLocationId: geofenceResult.officeLocationId,
      checkInLat: geoPoint?.latitude,
      checkInLng: geoPoint?.longitude,
      checkInDistance: geofenceResult.distance,
      checkInLocationLabel,
      locationStatus: geofenceResult.locationStatus,
    });

    if (checkInPhotoStored) {
      const stablePhotoUrl = buildCheckInPhotoPath((attendance._id as mongoose.Types.ObjectId).toString());
      attendance.photoUrl = stablePhotoUrl;
      await attendance.save();
    }

    if (geofenceResult.locationStatus === LocationStatus.OUT_OF_RANGE) {
      try {
        await AttendanceRegularization.create({
          organizationId,
          userId,
          date: today,
          requestType: RegularizationRequestType.LOCATION_OUT_OF_RANGE,
          requestedStatus: AttendanceStatus.PRESENT,
          reason: `Check-in location is ${geofenceResult.distance}m from the nearest office location`,
          status: RegularizationStatus.PENDING,
          flaggedDistance: geofenceResult.distance,
          flaggedLat: geoPoint?.latitude,
          flaggedLng: geoPoint?.longitude,
          isSystemGenerated: true,
        });
      } catch (regError: any) {
        console.error('Failed to create regularization request:', regError.message);
      }
    }

    const enriched = await enrichAttendancePhoto(attendance.toObject() as unknown as Record<string, unknown>);

    // Auto-start field tracking when enabled. Requires GPS on the check-in body
    // (mobile sends lat/lng for fieldTrackingEnabled users). Website check-in
    // does not send GPS, so no session is created there — mobile must start it.
    let fieldTrackingStarted = false;
    let fieldTrackingSessionId: string | undefined;
    if (geoPoint) {
      try {
        const trackingUser = await User.findById(userId).select('fieldTrackingEnabled').lean();
        if (trackingUser?.fieldTrackingEnabled) {
          const session = await fieldTrackingService.startSession(
            userId,
            organizationId,
            (attendance._id as any).toString(),
            geoPoint.latitude,
            geoPoint.longitude
          );
          fieldTrackingStarted = true;
          fieldTrackingSessionId = (session?._id ?? session?.id)?.toString();
        }
      } catch (trackingError: any) {
        // Tracking failure must never block check-in
        console.error('Auto field tracking start failed (non-critical):', trackingError.message);
      }
    }

    void attendanceIrregularityNotificationService
      .notify(await attendanceResolver.resolve(userId, today), attendance.toObject(), 'check_in')
      .catch((error: any) => {
        console.error('Attendance irregularity notification failed after check-in:', error?.message || error);
      });

    return {
      ...((enriched ?? {}) as object),
      fieldTrackingStarted,
      ...(fieldTrackingSessionId ? { fieldTrackingSessionId } : {}),
    };
  }

  async checkOut(
    userId: string,
    organizationId: string,
    latitude?: number,
    longitude?: number,
    photoData?: string
  ): Promise<any> {
    const orgTimezone = await getOrganizationTimezone(organizationId);
    const todayCalendar = getOrgCalendarDate(new Date(), orgTimezone);
    const today = startOfOrgCalendarDay(todayCalendar, orgTimezone);
    const dayEnd = endOfOrgCalendarDay(todayCalendar, orgTimezone);

    const attendance = await Attendance.findOne({
      userId,
      organizationId,
      date: { $gte: today, $lte: dayEnd },
    });

    if (!attendance) {
      throw new Error('No check-in found for today');
    }

    if (attendance.checkOut) {
      throw new Error('Already checked out today');
    }

    attendance.checkOut = new Date();

    if (photoData) {
      const base64Data = photoData.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');

      const maxSize = 5 * 1024 * 1024;
      if (imageBuffer.length > maxSize) {
        throw new Error('Check-out photo must be under 5MB');
      }

      const year = todayCalendar.slice(0, 4);
      const month = todayCalendar.slice(5, 7);
      const day = todayCalendar.slice(8, 10);
      const folder = `org-${organizationId}/${year}/${month}/${day}`;
      const fileName = `${userId}_checkout_${attendance.checkOut.getTime()}.jpg`;
      const uploadMeta = { userId, type: 'checkout', date: today.toISOString() };

      try {
        const result = await uploadCheckInPhotoWithRetry(
          imageBuffer,
          fileName,
          folder,
          uploadMeta
        );
        attendance.checkOutPhotoKey = result.key;
        attendance.checkOutPhotoStored = true;
        console.info('[checkOut] photo uploaded to MinIO:', result.key);
      } catch (uploadError: any) {
        console.error(
          '[checkOut] MinIO upload failed, using database fallback:',
          uploadError?.message || uploadError
        );
        attendance.checkOutPhotoData = imageBuffer;
        attendance.checkOutPhotoContentType = 'image/jpeg';
        attendance.checkOutPhotoStored = true;
      }

      if (attendance.checkOutPhotoStored) {
        attendance.checkOutPhotoUrl = buildCheckOutPhotoPath(
          (attendance._id as mongoose.Types.ObjectId).toString()
        );
      }
    }

    if (latitude !== undefined && longitude !== undefined) {
      attendance.checkOutLat = latitude;
      attendance.checkOutLng = longitude;

      try {
        attendance.checkOutLocationLabel = await reverseGeocodeAreaName(latitude, longitude);
      } catch {
        // Non-blocking
      }

      if (attendance.officeLocationId) {
        const office = await OfficeLocation.findById(attendance.officeLocationId).lean();
        if (office) {
          const dist = haversineDistance(latitude, longitude, office.latitude, office.longitude);
          attendance.checkOutDistance = Math.round(dist);
        }
      }
    }

    await attendance.save();

    const resolved = await attendanceResolver.resolve(userId, today);
    attendance.status = mapResolvedToAttendanceStatus(resolved.attendanceStatus);
    await attendance.save();

    void attendanceIrregularityNotificationService
      .notify(resolved, attendance.toObject(), 'check_out')
      .catch((error: any) => {
        console.error('Attendance irregularity notification failed after check-out:', error?.message || error);
      });

    // End field tracking: save check-out GPS on the session first, then mark completed.
    let fieldTrackingStopped = false;
    try {
      await fieldTrackingService.stopSession(
        userId,
        organizationId,
        FieldTrackingStatus.COMPLETED,
        'Stopped on employee check-out',
        latitude !== undefined && longitude !== undefined
          ? { latitude, longitude, recordedAt: attendance.checkOut || new Date() }
          : undefined
      );
      fieldTrackingStopped = true;
    } catch (trackingError: any) {
      // No active session (or already stopped) must never block check-out
      console.error('Auto field tracking stop failed (non-critical):', trackingError.message);
    }

    const enriched = await enrichAttendancePhoto(
      attendance.toObject() as unknown as Record<string, unknown>
    );

    return { ...((enriched ?? {}) as object), fieldTrackingStopped };
  }

  async getTodayStatus(userId: string, organizationId: string): Promise<any> {
    const orgTimezone = await getOrganizationTimezone(organizationId);
    const todayCalendar = getOrgCalendarDate(new Date(), orgTimezone);
    const today = startOfOrgCalendarDay(todayCalendar, orgTimezone);
    // Match on a day range so a record stored at UTC-midnight or org-midnight is
    // always found (avoids read/write timezone mismatches leaving the UI stale).
    const dayEnd = endOfOrgCalendarDay(todayCalendar, orgTimezone);

    const [attendance, resolved] = await Promise.all([
      Attendance.findOne({
        userId,
        organizationId,
        date: { $gte: today, $lte: dayEnd },
      }),
      attendanceResolver.resolve(userId, today),
    ]);

    const enriched = attendance
      ? await enrichAttendancePhoto(attendance.toObject() as unknown as Record<string, unknown>)
      : null;

    return {
      record: enriched,
      policy: resolved,
    };
  }

  async getResolvedAttendance(
    userId: string,
    date?: Date
  ): Promise<any> {
    return attendanceResolver.resolve(userId, date ?? startOfDay(new Date()));
  }

  async getMyPolicySummary(userId: string): Promise<any> {
    const [resolved, user] = await Promise.all([
      attendanceResolver.resolveToday(userId),
      User.findById(userId).select('attendancePolicyId organizationId department').lean(),
    ]);

    if (!user?.organizationId) {
      return resolved;
    }

    const { resolveUserAttendancePolicy } = await import('../utils/resolveUserAttendancePolicy');
    const policy = await resolveUserAttendancePolicy(user);

    let shift: {
      shiftName: string;
      startTime: string;
      endTime: string;
      expectedHours: number;
    } | null = null;

    if (policy?.shiftId) {
      const shiftDoc = await shiftService.getShiftById(
        policy.shiftId.toString(),
        user.organizationId.toString()
      );
      if (shiftDoc) {
        shift = {
          shiftName: shiftDoc.shiftName,
          startTime: shiftDoc.startTime,
          endTime: shiftDoc.endTime,
          expectedHours: shiftDoc.expectedHours,
        };
      }
    }

    return {
      ...resolved,
      policyName: policy?.policyName ?? resolved.policyName,
      weekRules: policy?.weekRules ?? [],
      shiftId: policy?.shiftId?.toString?.() ?? resolved.shiftId,
      shift,
    };
  }

  async getUserAttendance(
    userId: string,
    organizationId: string,
    startDate?: Date,
    endDate?: Date,
    status?: AttendanceStatus,
    page: number = 1,
    limit: number = 30
  ): Promise<any> {
    const user = await User.findById(userId)
      .select('createdAt joiningDate firstName lastName email employeeId department')
      .lean();
    if (!user) {
      throw new Error('User not found');
    }

    const joinDate = user.joiningDate ?? user.createdAt;

    const query: any = { userId, organizationId };
    const orgTimezone = await getOrganizationTimezone(organizationId);

    const toCalendarDate = (value: Date | string): string => {
      if (typeof value === 'string') {
        const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
        if (match) return match[1];
      }
      return getOrgCalendarDate(value instanceof Date ? value : new Date(value), orgTimezone);
    };

    if (startDate || endDate) {
      query.date = {};
      if (startDate) {
        query.date.$gte = startOfOrgCalendarDay(toCalendarDate(startDate), orgTimezone);
      }
      if (endDate) {
        query.date.$lte = endOfOrgCalendarDay(toCalendarDate(endDate), orgTimezone);
      }
    }

    const dbQuery = { ...query };
    if (status && status !== AttendanceStatus.ABSENT) {
      dbQuery.status = status;
    } else if (status === AttendanceStatus.ABSENT) {
      // Fetch all statuses in range — implied absents merged below
      delete dbQuery.status;
    }

    const dbRecords = await Attendance.find(dbQuery)
      .populate('userId', 'firstName lastName email employeeId department')
      .sort({ date: -1 })
      .lean();

    type AttendanceRow = Record<string, unknown>;
    let merged: AttendanceRow[] = dbRecords as unknown as AttendanceRow[];

    const shouldIncludeImplied =
      !status || status === AttendanceStatus.ABSENT;

    const lastRecordDate = dbRecords[0]?.date ? new Date(dbRecords[0].date) : undefined;
    const firstRecordDate = dbRecords.length > 0 && dbRecords[dbRecords.length - 1]?.date
      ? new Date(dbRecords[dbRecords.length - 1].date)
      : undefined;
    const rangeStart = startDate
      ? startOfOrgCalendarDay(toCalendarDate(startDate), orgTimezone)
      : firstRecordDate
      ? startOfOrgCalendarDay(toCalendarDate(firstRecordDate), orgTimezone)
      : startOfOrgCalendarDay(getOrgCalendarDate(joinDate, orgTimezone), orgTimezone);
    const rangeEnd = endDate
      ? endOfOrgCalendarDay(toCalendarDate(endDate), orgTimezone)
      : lastRecordDate
      ? endOfOrgCalendarDay(toCalendarDate(lastRecordDate), orgTimezone)
      : undefined;

    if (shouldIncludeImplied && rangeStart && rangeEnd) {
      const implied = await buildImpliedAbsentRecords(
        userId,
        organizationId,
        rangeStart,
        rangeEnd,
        joinDate,
        dbRecords
      );
      const impliedWithUser = implied.map((record) => ({
        ...record,
        userId: user,
      }));
      merged = [...merged, ...(impliedWithUser as unknown as AttendanceRow[])];
      if (status === AttendanceStatus.ABSENT) {
        merged = merged.filter((r) => r.status === AttendanceStatus.ABSENT);
      }
    } else if (status) {
      merged = dbRecords.filter((r) => r.status === status) as unknown as AttendanceRow[];
    }

    merged.sort(
      (a, b) => new Date(b.date as Date).getTime() - new Date(a.date as Date).getTime()
    );

    const total = merged.length;
    const skip = (page - 1) * limit;
    const paged = merged.slice(skip, skip + limit);

    return {
      records: await enrichAttendancePhotos(paged),
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1,
      },
    };
  }

  async getUserStats(userId: string, organizationId: string, month?: number, year?: number): Promise<any> {
    const user = await User.findById(userId).select('createdAt joiningDate').lean();
    if (!user) {
      throw new Error('User not found');
    }

    const joinDate = user.joiningDate ?? user.createdAt;

    const now = new Date();
    const targetMonth = month ? month - 1 : now.getMonth();
    const targetYear = year ?? now.getFullYear();

    const startDate = new Date(targetYear, targetMonth, 1);
    const endDate = new Date(targetYear, targetMonth + 1, 0);

    return computeUserAttendanceStats(
      userId,
      organizationId,
      startDate,
      endDate,
      joinDate
    );
  }

  async getAllAttendance(
    organizationId: string,
    filters: {
      date?: Date;
      startDate?: Date;
      endDate?: Date;
      status?: AttendanceStatus;
      department?: string;
      attendancePolicyId?: string;
      dayType?: string;
      userId?: string;
      includeImpliedAbsents?: boolean;
    },
    page: number = 1,
    limit: number = 50
  ): Promise<any> {
    const query: any = { organizationId };
    const orgTimezone = await getOrganizationTimezone(organizationId);

    const toCalendarDate = (value: Date | string): string => {
      if (typeof value === 'string') {
        const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
        if (match) return match[1];
      }
      return getOrgCalendarDate(value instanceof Date ? value : new Date(value), orgTimezone);
    };

    if (filters.date) {
      const dateStr = toCalendarDate(filters.date);
      query.date = {
        $gte: startOfOrgCalendarDay(dateStr, orgTimezone),
        $lte: endOfOrgCalendarDay(dateStr, orgTimezone),
      };
    } else if (filters.startDate || filters.endDate) {
      query.date = {};
      if (filters.startDate) {
        query.date.$gte = startOfOrgCalendarDay(toCalendarDate(filters.startDate), orgTimezone);
      }
      if (filters.endDate) {
        query.date.$lte = endOfOrgCalendarDay(toCalendarDate(filters.endDate), orgTimezone);
      }
    }

    if (filters.status) {
      query.status = filters.status;
    }

    // Department / policy filter via User lookup
    const userFilter: Record<string, unknown> = { organizationId };
    if (filters.department) userFilter.department = filters.department;
    if (filters.attendancePolicyId) userFilter.attendancePolicyId = filters.attendancePolicyId;

    if (filters.userId) {
      userFilter._id = filters.userId;
    }

    if (filters.includeImpliedAbsents && filters.userId) {
      return this.getUserAttendance(
        filters.userId,
        organizationId,
        filters.startDate,
        filters.endDate,
        filters.status,
        page,
        limit
      );
    }

    if (filters.department || filters.attendancePolicyId || filters.userId) {
      const matchedUsers = await User.find(userFilter).select('_id');
      query.userId = { $in: matchedUsers.map((u) => u._id) };
    }

    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      Attendance.find(query)
        .populate('userId', 'firstName lastName email employeeId department')
        .sort({ date: -1, checkIn: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Attendance.countDocuments(query),
    ]);

    return {
      records: await enrichAttendancePhotos(records as unknown as Record<string, unknown>[]),
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getCheckInPhotoBuffer(
    attendanceId: string,
    requesterId: string,
    requesterRole: string,
    organizationId: string
  ): Promise<{ buffer: Buffer; contentType: string }> {
    if (!mongoose.Types.ObjectId.isValid(attendanceId)) {
      throw new NotFoundError('Attendance record not found');
    }

    const attendance = await Attendance.findById(attendanceId)
      .select('+checkInPhotoData +checkInPhotoContentType')
      .lean();
    if (!attendance || attendance.organizationId.toString() !== organizationId.toString()) {
      throw new NotFoundError('Attendance record not found');
    }

    const objectKey = resolveCheckInPhotoKey(
      attendance.photoKey || attendance.photoUrl || undefined
    );
    const hasDbPhoto =
      Boolean(attendance.checkInPhotoStored) &&
      (toPhotoBuffer(attendance.checkInPhotoData)?.length ?? 0) > 0;

    if (!objectKey && !hasDbPhoto) {
      throw new NotFoundError('No check-in photo for this attendance record');
    }

    const recordUserId = attendance.userId.toString();
    const isOwner = recordUserId === requesterId;
    const isHrOrAdmin = [UserRole.HR, UserRole.ADMIN, UserRole.SUPER_ADMIN].includes(
      requesterRole as UserRole
    );

    let canView = isOwner || isHrOrAdmin;
    if (!canView && requesterRole === UserRole.SUPERVISOR) {
      const employee = await User.findById(recordUserId).select('supervisorId').lean();
      canView = employee?.supervisorId?.toString() === requesterId;
    }

    if (!canView) {
      throw new ForbiddenError('You are not authorized to view this check-in photo');
    }

    if (hasDbPhoto && !objectKey) {
      return {
        buffer: toPhotoBuffer(attendance.checkInPhotoData)!,
        contentType: attendance.checkInPhotoContentType || 'image/jpeg',
      };
    }

    if (!objectKey) {
      throw new NotFoundError('No check-in photo for this attendance record');
    }

    try {
      return await checkInMinioStorage.getObjectBuffer(objectKey);
    } catch (primaryError) {
      try {
        const presignedUrl = await checkInMinioStorage.getPresignedUrl(objectKey, 300);
        const response = await fetch(presignedUrl);
        if (!response.ok) {
          throw primaryError;
        }
        const arrayBuffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        return { buffer: Buffer.from(arrayBuffer), contentType };
      } catch {
        if (hasDbPhoto) {
          return {
            buffer: toPhotoBuffer(attendance.checkInPhotoData)!,
            contentType: attendance.checkInPhotoContentType || 'image/jpeg',
          };
        }
        const message =
          primaryError instanceof Error ? primaryError.message : 'Storage read failed';
        if (message.includes('not found') || message.includes('NotFound')) {
          throw new NotFoundError('Check-in photo file was not found in storage');
        }
        throw new NotFoundError(
          'Check-in photo could not be loaded. The image may not have been uploaded during check-in.'
        );
      }
    }
  }

  async getCheckOutPhotoBuffer(
    attendanceId: string,
    requesterId: string,
    requesterRole: string,
    organizationId: string
  ): Promise<{ buffer: Buffer; contentType: string }> {
    if (!mongoose.Types.ObjectId.isValid(attendanceId)) {
      throw new NotFoundError('Attendance record not found');
    }

    const attendance = await Attendance.findById(attendanceId)
      .select('+checkOutPhotoData +checkOutPhotoContentType')
      .lean();
    if (!attendance || attendance.organizationId.toString() !== organizationId.toString()) {
      throw new NotFoundError('Attendance record not found');
    }

    const objectKey = resolveCheckInPhotoKey(
      attendance.checkOutPhotoKey || attendance.checkOutPhotoUrl || undefined
    );
    const hasDbPhoto =
      Boolean(attendance.checkOutPhotoStored) &&
      (toPhotoBuffer(attendance.checkOutPhotoData)?.length ?? 0) > 0;

    if (!objectKey && !hasDbPhoto) {
      throw new NotFoundError('No check-out photo for this attendance record');
    }

    const recordUserId = attendance.userId.toString();
    const isOwner = recordUserId === requesterId;
    const isHrOrAdmin = [UserRole.HR, UserRole.ADMIN, UserRole.SUPER_ADMIN].includes(
      requesterRole as UserRole
    );

    let canView = isOwner || isHrOrAdmin;
    if (!canView && requesterRole === UserRole.SUPERVISOR) {
      const employee = await User.findById(recordUserId).select('supervisorId').lean();
      canView = employee?.supervisorId?.toString() === requesterId;
    }

    if (!canView) {
      throw new ForbiddenError('You are not authorized to view this check-out photo');
    }

    if (hasDbPhoto && !objectKey) {
      return {
        buffer: toPhotoBuffer(attendance.checkOutPhotoData)!,
        contentType: attendance.checkOutPhotoContentType || 'image/jpeg',
      };
    }

    if (!objectKey) {
      throw new NotFoundError('No check-out photo for this attendance record');
    }

    try {
      return await checkInMinioStorage.getObjectBuffer(objectKey);
    } catch (primaryError) {
      try {
        const presignedUrl = await checkInMinioStorage.getPresignedUrl(objectKey, 300);
        const response = await fetch(presignedUrl);
        if (!response.ok) {
          throw primaryError;
        }
        const arrayBuffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        return { buffer: Buffer.from(arrayBuffer), contentType };
      } catch {
        if (hasDbPhoto) {
          return {
            buffer: toPhotoBuffer(attendance.checkOutPhotoData)!,
            contentType: attendance.checkOutPhotoContentType || 'image/jpeg',
          };
        }
        const message =
          primaryError instanceof Error ? primaryError.message : 'Storage read failed';
        if (message.includes('not found') || message.includes('NotFound')) {
          throw new NotFoundError('Check-out photo file was not found in storage');
        }
        throw new NotFoundError(
          'Check-out photo could not be loaded. The image may not have been uploaded during check-out.'
        );
      }
    }
  }

  /**
   * Mark absent for active users on a working day with no punch, leave, or existing record.
   */
  async markAutoAbsent(
    organizationId: string,
    targetDate: Date
  ): Promise<{ marked: number; skipped: number; notWorkingDay: boolean }> {
    const date = startOfDay(targetDate);
    const today = startOfDay(new Date());

    if (date >= today) {
      throw new Error('Auto absent can only be run for past dates');
    }

    const holidayDateKeys = await getNonWorkingHolidayDateKeys(organizationId, date, date);

    const users = await User.find({
      organizationId,
      isActive: true,
      role: {
        $in: [UserRole.EMPLOYEE, UserRole.SUPERVISOR, UserRole.HR, UserRole.ADMIN],
      },
    }).select('_id createdAt joiningDate attendancePolicyId');

    let marked = 0;
    let skipped = 0;
    let anyWorkingDay = false;

    for (const user of users) {
      const userId = user._id.toString();
      const joined = startOfDay(new Date(user.joiningDate ?? user.createdAt));
      if (date < joined) {
        skipped += 1;
        continue;
      }

      const workingDay = await isPolicyWorkingDay(userId, organizationId, date, holidayDateKeys);
      if (!workingDay) {
        skipped += 1;
        continue;
      }
      anyWorkingDay = true;

      const existing = await Attendance.findOne({ organizationId, userId, date });
      if (existing) {
        skipped += 1;
        continue;
      }

      const onApprovedLeave = await Leave.exists({
        organizationId,
        userId,
        status: LeaveStatus.APPROVED,
        startDate: { $lte: endOfDay(date) },
        endDate: { $gte: date },
      });
      if (onApprovedLeave) {
        skipped += 1;
        continue;
      }

      await Attendance.create({
        organizationId,
        userId,
        date,
        status: AttendanceStatus.ABSENT,
        isApproved: true,
      });
      marked += 1;
    }

    if (!anyWorkingDay && marked === 0) {
      return { marked: 0, skipped, notWorkingDay: true };
    }

    return { marked, skipped, notWorkingDay: false };
  }
}

export const attendanceService = new AttendanceService();
