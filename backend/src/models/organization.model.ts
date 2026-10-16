import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

/**
 * One company: departments and the rooms inside them. Records are deactivated, never deleted,
 * because tickets, people and stock movements keep referring to them.
 */
export const ORG_LIMITS = { nameMax: 80, codeMax: 12, descriptionMax: 300, buildingMax: 60, floorMax: 20 } as const;

export interface Department {
  name: string;
  /** Normalized name (lowercase, no accents) for uniqueness. */
  nameKey: string;
  code: string | null;
  description: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Room {
  department: Types.ObjectId;
  name: string;
  nameKey: string;
  building: string | null;
  floor: string | null;
  description: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type DepartmentDocument = HydratedDocument<Department>;
export type RoomDocument = HydratedDocument<Room>;

const departmentSchema = new Schema<Department>(
  {
    name: { type: String, required: true, trim: true, maxlength: ORG_LIMITS.nameMax },
    nameKey: { type: String, required: true },
    code: { type: String, trim: true, uppercase: true, maxlength: ORG_LIMITS.codeMax, default: null },
    description: { type: String, trim: true, maxlength: ORG_LIMITS.descriptionMax, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
departmentSchema.index({ nameKey: 1 }, { unique: true });
departmentSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });

const roomSchema = new Schema<Room>(
  {
    department: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    name: { type: String, required: true, trim: true, maxlength: ORG_LIMITS.nameMax },
    nameKey: { type: String, required: true },
    building: { type: String, trim: true, maxlength: ORG_LIMITS.buildingMax, default: null },
    floor: { type: String, trim: true, maxlength: ORG_LIMITS.floorMax, default: null },
    description: { type: String, trim: true, maxlength: ORG_LIMITS.descriptionMax, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
// A room name is unique inside its department ("Sala 203" may exist in two departments).
roomSchema.index({ department: 1, nameKey: 1 }, { unique: true });

export const DepartmentModel = model<Department>('Department', departmentSchema);
export const RoomModel = model<Room>('Room', roomSchema);
