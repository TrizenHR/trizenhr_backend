import { Request, Response } from 'express';
import { attendanceService } from '../services/attendanceService';
import { AttendanceStatus } from '../models/Attendance';
import User, { UserRole } from '../models/User';
import { parseLocalDateInput } from '../utils/dateInput';
import { ForbiddenError, NotFoundError } from '../utils/AppError';
import { reverseGeocodeAreaName } from '../utils/reverseGeocode';

export class AttendanceController {
  async checkIn(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.userId;
      const { photoData, latitude, longitude } = req.body;

      const attendance = await attendanceService.checkIn(
        userId,
        req.organizationId!,
        photoData,
        latitude ? parseFloat(latitude) : undefined,
        longitude ? parseFloat(longitude) : undefined
      );

      res.status(200).json({
        success: true,
        message: 'Checked in successfully',
        data: attendance,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        error: error.message || 'Failed to check in',
        timestamp: new Date().toISOString(),
      });
    }
  }

  async checkOut(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.userId;
      const { photoData, latitude, longitude } = req.body;

      const attendance = await attendanceService.checkOut(
        userId,
        req.organizationId!,
        latitude ? parseFloat(latitude) : undefined,
        longitude ? parseFloat(longitude) : undefined,
        photoData
      );

      res.status(200).json({
        success: true,
        message: 'Checked out successfully',
        data: attendance,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        error: error.message || 'Failed to check out',
        timestamp: new Date().toISOString(),
      });
    }
  }

  async getTodayStatus(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.userId;
      const status = await attendanceService.getTodayStatus(userId, req.organizationId!);

      res.status(200).json({
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to get status',
        timestamp: new Date().toISOString(),
      });
    }
  }

  async getMyPolicy(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.userId;
      const policy = await attendanceService.getMyPolicySummary(userId);

      res.status(200).json({
        success: true,
        data: policy,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to get policy summary',
        timestamp: new Date().toISOString(),
      });
    }
  }

  async getMyAttendance(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.userId;
      const { startDate, endDate, status, page, limit } = req.query;

      const result = await attendanceService.getUserAttendance(
        userId,
        req.organizationId!,
        startDate ? parseLocalDateInput(startDate as string) : undefined,
        endDate ? parseLocalDateInput(endDate as string) : undefined,
        status ? (status as AttendanceStatus) : undefined,
        page ? parseInt(page as string) : undefined,
        limit ? parseInt(limit as string) : undefined
      );

      res.status(200).json({
        success: true,
        data: result.records,
        pagination: result.pagination,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to get attendance',
        timestamp: new Date().toISOString(),
      });
    }
  }

  async getMyStats(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user!.userId;
      const { month, year } = req.query;

      const stats = await attendanceService.getUserStats(
        userId,
        req.organizationId!,
        month ? parseInt(month as string) : undefined,
        year ? parseInt(year as string) : undefined
      );

      res.status(200).json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to get statistics',
        timestamp: new Date().toISOString(),
      });
    }
  }

  async getAllAttendance(req: Request, res: Response): Promise<void> {
    try {
      const {
        date,
        startDate,
        endDate,
        status,
        department,
        attendancePolicyId,
        dayType,
        userId,
        page,
        limit,
      } = req.query;

      const filters: Record<string, unknown> = {};
      if (date) filters.date = new Date(date as string);
      if (startDate) filters.startDate = parseLocalDateInput(startDate as string);
      if (endDate) filters.endDate = parseLocalDateInput(endDate as string);
      if (status) filters.status = status as AttendanceStatus;
      if (department) filters.department = department as string;
      if (attendancePolicyId) filters.attendancePolicyId = attendancePolicyId as string;
      if (dayType) filters.dayType = dayType as string;
      if (userId) filters.userId = userId as string;
      if (req.query.includeImpliedAbsents === 'true') {
        filters.includeImpliedAbsents = true;
      }

      const result = await attendanceService.getAllAttendance(
        req.organizationId!,
        filters as any,
        page ? parseInt(page as string) : undefined,
        limit ? parseInt(limit as string) : undefined
      );

      res.status(200).json({
        success: true,
        data: result.records,
        pagination: result.pagination,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to get attendance',
        timestamp: new Date().toISOString(),
      });
    }
  }

  async getUserAttendance(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params as { userId: string };
      const { startDate, endDate, page, limit } = req.query;

      if (req.user!.role === UserRole.SUPERVISOR) {
        const targetUser = await User.findOne({
          _id: userId,
          organizationId: req.organizationId,
        }).select('supervisorId department');

        const isDirectReport = targetUser?.supervisorId?.toString() === req.user!.userId;

        // Fallback: allow if target is in the same department as the supervisor
        let isSameDepartment = false;
        if (!isDirectReport && targetUser) {
          const supervisor = await User.findById(req.user!.userId).select('department').lean();
          isSameDepartment = !!(supervisor?.department && targetUser.department === supervisor.department);
        }

        if (!targetUser || (!isDirectReport && !isSameDepartment)) {
          res.status(403).json({
            success: false,
            error: 'You can only view attendance for your team members',
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      const result = await attendanceService.getUserAttendance(
        userId,
        req.organizationId!,
        startDate ? parseLocalDateInput(startDate as string) : undefined,
        endDate ? parseLocalDateInput(endDate as string) : undefined,
        undefined,
        page ? parseInt(page as string) : undefined,
        limit ? parseInt(limit as string) : undefined
      );

      res.status(200).json({
        success: true,
        data: result.records,
        pagination: result.pagination,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to get attendance',
        timestamp: new Date().toISOString(),
      });
    }
  }

  async getCheckInPhoto(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params as { id: string };

      const { buffer, contentType } = await attendanceService.getCheckInPhotoBuffer(
        id,
        req.user!.userId,
        req.user!.role,
        req.organizationId!
      );

      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'private, max-age=3600');
      res.send(buffer);
    } catch (error: unknown) {
      if (error instanceof NotFoundError) {
        res.status(404).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      if (error instanceof ForbiddenError) {
        res.status(403).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      const message = error instanceof Error ? error.message : 'Failed to get check-in photo';
      res.status(500).json({
        success: false,
        error: message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  async getCheckOutPhoto(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params as { id: string };

      const { buffer, contentType } = await attendanceService.getCheckOutPhotoBuffer(
        id,
        req.user!.userId,
        req.user!.role,
        req.organizationId!
      );

      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'private, max-age=3600');
      res.send(buffer);
    } catch (error: unknown) {
      if (error instanceof NotFoundError) {
        res.status(404).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      if (error instanceof ForbiddenError) {
        res.status(403).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      const message = error instanceof Error ? error.message : 'Failed to get check-out photo';
      res.status(500).json({
        success: false,
        error: message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  async getAreaName(req: Request, res: Response): Promise<void> {
    try {
      const latitude = parseFloat(String(req.query.lat ?? ''));
      const longitude = parseFloat(String(req.query.lng ?? ''));

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        res.status(400).json({
          success: false,
          error: 'Query parameters lat and lng are required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const label = await reverseGeocodeAreaName(latitude, longitude);
      res.status(200).json({
        success: true,
        data: { label: label ?? null },
        timestamp: new Date().toISOString(),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to resolve area name';
      res.status(500).json({
        success: false,
        error: message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  async markAutoAbsent(req: Request, res: Response): Promise<void> {
    try {
      const dateParam = req.body.date || req.query.date;
      const targetDate = dateParam
        ? new Date(dateParam as string)
        : new Date(Date.now() - 86400000);

      const result = await attendanceService.markAutoAbsent(req.organizationId!, targetDate);

      if (result.notWorkingDay) {
        res.status(400).json({
          success: false,
          error: 'Selected date is not a working day for this organization',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.status(200).json({
        success: true,
        message: `Marked ${result.marked} employee(s) as absent`,
        data: result,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        error: error.message || 'Failed to mark auto absent',
        timestamp: new Date().toISOString(),
      });
    }
  }
}

export const attendanceController = new AttendanceController();
