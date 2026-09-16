import mongoose, { Document, Schema } from 'mongoose';

export interface IAttendanceIrregularityNotification extends Document {
  organizationId: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  recipientId: mongoose.Types.ObjectId;
  date: Date;
  status: string;
  notificationType: string;
  createdAt: Date;
}

const AttendanceIrregularityNotificationSchema = new Schema<IAttendanceIrregularityNotification>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: Date, required: true },
    status: { type: String, required: true },
    notificationType: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AttendanceIrregularityNotificationSchema.index(
  { organizationId: 1, employeeId: 1, recipientId: 1, date: 1, notificationType: 1 },
  { unique: true }
);

export default mongoose.model<IAttendanceIrregularityNotification>(
  'AttendanceIrregularityNotification',
  AttendanceIrregularityNotificationSchema
);