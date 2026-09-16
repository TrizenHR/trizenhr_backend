import http from 'http';
import config from './config';
import createApp from './app';
import connectDB from './config/db';
import { connectRedis } from './config/redis';
import { logEmailServiceConfigAtStartup } from './services/emailNotificationService';
import { startBirthdayEmailScheduler } from './jobs/birthdayEmailScheduler';
import { startAttendanceIrregularityEmailScheduler } from './jobs/attendanceIrregularityEmailScheduler';
import { attachFieldTrackingSocket } from './socket/fieldTrackingSocket';

const startServer = async (): Promise<void> => {
  try {
    // Connect to MongoDB
    await connectDB();

    logEmailServiceConfigAtStartup();

    // Create Express app + HTTP server so Socket.IO can share the port
    const app = createApp();
    const httpServer = http.createServer(app);

    await connectRedis();
    await attachFieldTrackingSocket(httpServer);

    httpServer.listen(config.port, () => {
      console.info(`🚀 Server running in ${config.nodeEnv} mode on port ${config.port}`);
      console.info(`📍 Health check: http://localhost:${config.port}/api/health`);
      startBirthdayEmailScheduler();
      startAttendanceIrregularityEmailScheduler();
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown) => {
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.info('SIGTERM received. Performing graceful shutdown...');
  process.exit(0);
});

void startServer();
