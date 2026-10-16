import { Types } from 'mongoose';
import { can } from '../auth/permissions';
import { HttpError } from '../errors/http-error';
import { DepartmentModel, RoomModel, type DepartmentDocument, type RoomDocument } from '../models/organization.model';
import { UserModel, type PublicUser } from '../models/user.model';
import { normalizeForSearch } from './article.service';

// ---------- Views ----------

export interface RoomView {
  id: string;
  departmentId: string;
  name: string;
  building: string | null;
  floor: string | null;
  description: string | null;
  active: boolean;
}

export interface DepartmentView {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  active: boolean;
  rooms: RoomView[];
}

/** Where something is: ids for references and names as they were, so history stays readable. */
export interface LocationSnapshot {
  departmentId: Types.ObjectId;
  departmentName: string;
  roomId: Types.ObjectId | null;
  roomName: string | null;
}

export interface LocationView {
  department: { id: string; name: string };
  room: { id: string; name: string } | null;
}

export interface PersonView {
  id: string;
  name: string;
  role: string;
  jobTitle: string | null;
  department: { id: string; name: string } | null;
  room: { id: string; name: string } | null;
}

export const toLocationView = (location: LocationSnapshot | null | undefined): LocationView | null =>
  location?.departmentId
    ? { department: { id: location.departmentId.toString(), name: location.departmentName }, room: location.roomId ? { id: location.roomId.toString(), name: location.roomName ?? '' } : null }
    : null;

const roomView = (room: RoomDocument): RoomView => ({
  id: room.id, departmentId: room.department.toString(), name: room.name, building: room.building ?? null,
  floor: room.floor ?? null, description: room.description ?? null, active: room.active,
});

const departmentView = (department: DepartmentDocument, rooms: RoomDocument[]): DepartmentView => ({
  id: department.id, name: department.name, code: department.code ?? null, description: department.description ?? null,
  active: department.active, rooms: rooms.filter((room) => room.department.equals(department._id)).map(roomView),
});

const isDuplicate = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
const objectId = (id: string, what: string) => {
  if (!Types.ObjectId.isValid(id)) throw new HttpError(400, `Invalid ${what} id`);
  return new Types.ObjectId(id);
};

// ---------- Reading ----------

/** The company structure. Requesters see only active entries (to say where a problem is). */
export async function listOrganization(actor: PublicUser, includeInactive: boolean): Promise<DepartmentView[]> {
  const all = includeInactive && can(actor.role, 'org:manage');
  const filter = all ? {} : { active: true };
  const [departments, rooms] = await Promise.all([
    DepartmentModel.find(filter).sort({ nameKey: 1 }),
    RoomModel.find(filter).sort({ nameKey: 1 }),
  ]);
  return departments.map((department) => departmentView(department, rooms));
}

/** The authenticated person's usual department and room, if both are still active. */
export async function myLocation(actor: PublicUser): Promise<LocationView | null> {
  const user = await UserModel.findById(actor.id).select('department room');
  if (!user?.department) return null;
  try {
    return toLocationView(await resolveLocation(user.department.toString(), user.room?.toString() ?? null));
  } catch {
    return null;
  }
}

/**
 * Validates a department (and optionally a room inside it) and returns its snapshot. A room alone
 * is enough: its department comes from the room. Inactive entries are refused for new records.
 */
export async function resolveLocation(departmentId: string | null | undefined, roomId: string | null | undefined): Promise<LocationSnapshot> {
  const room = roomId ? await RoomModel.findById(objectId(roomId, 'room')) : null;
  if (roomId && (!room || !room.active)) throw new HttpError(400, 'Unknown or inactive room');
  const departmentRef = departmentId ? objectId(departmentId, 'department') : room?.department;
  if (!departmentRef) throw new HttpError(400, 'A department or a room is required');
  if (room && !room.department.equals(departmentRef)) throw new HttpError(400, 'The room does not belong to this department');
  const department = await DepartmentModel.findById(departmentRef);
  if (!department || !department.active) throw new HttpError(400, 'Unknown or inactive department');
  return { departmentId: department._id, departmentName: department.name, roomId: room?._id ?? null, roomName: room?.name ?? null };
}

// ---------- Writing (org:manage) ----------

export interface DepartmentInput { name?: string; code?: string | null; description?: string | null; active?: boolean }
export interface RoomInput { departmentId?: string; name?: string; building?: string | null; floor?: string | null; description?: string | null; active?: boolean }

export async function createDepartment(input: DepartmentInput & { name: string }): Promise<DepartmentView> {
  try {
    const department = await DepartmentModel.create({ ...input, nameKey: normalizeForSearch(input.name.trim()) });
    return departmentView(department, []);
  } catch (error) {
    if (isDuplicate(error)) throw new HttpError(409, 'A department with this name or code already exists');
    throw error;
  }
}

export async function updateDepartment(id: string, input: DepartmentInput): Promise<DepartmentView> {
  const department = await DepartmentModel.findById(objectId(id, 'department'));
  if (!department) throw new HttpError(404, 'Department not found');
  department.set({ ...input, ...(input.name !== undefined && { nameKey: normalizeForSearch(input.name.trim()) }) });
  try {
    await department.save();
  } catch (error) {
    if (isDuplicate(error)) throw new HttpError(409, 'A department with this name or code already exists');
    throw error;
  }
  return departmentView(department, await RoomModel.find({ department: department._id }).sort({ nameKey: 1 }));
}

export async function createRoom(input: RoomInput & { departmentId: string; name: string }): Promise<RoomView> {
  const department = await DepartmentModel.findById(objectId(input.departmentId, 'department'));
  if (!department || !department.active) throw new HttpError(400, 'Unknown or inactive department');
  const { departmentId: _department, ...fields } = input;
  try {
    return roomView(await RoomModel.create({ ...fields, department: department._id, nameKey: normalizeForSearch(input.name.trim()) }));
  } catch (error) {
    if (isDuplicate(error)) throw new HttpError(409, 'This department already has a room with this name');
    throw error;
  }
}

/** The department of a room never changes: past tickets and movements keep their meaning. */
export async function updateRoom(id: string, input: Omit<RoomInput, 'departmentId'>): Promise<RoomView> {
  const room = await RoomModel.findById(objectId(id, 'room'));
  if (!room) throw new HttpError(404, 'Room not found');
  room.set({ ...input, ...(input.name !== undefined && { nameKey: normalizeForSearch(input.name.trim()) }) });
  try {
    await room.save();
  } catch (error) {
    if (isDuplicate(error)) throw new HttpError(409, 'This department already has a room with this name');
    throw error;
  }
  return roomView(room);
}

// ---------- People ----------

export async function listPeople(): Promise<PersonView[]> {
  const [users, departments, rooms] = await Promise.all([
    UserModel.find({ active: { $ne: false } }).select('name role jobTitle department room').sort({ name: 1 }),
    DepartmentModel.find().select('name'),
    RoomModel.find().select('name'),
  ]);
  const name = (list: { _id: Types.ObjectId; name: string }[], id?: Types.ObjectId | null) => {
    const found = id ? list.find((item) => item._id.equals(id)) : null;
    return found ? { id: found._id.toString(), name: found.name } : null;
  };
  return users.map((user) => ({
    id: user.id, name: user.name, role: user.role, jobTitle: user.jobTitle ?? null,
    department: name(departments, user.department), room: name(rooms, user.room),
  }));
}

/** Where a person usually works. Only org:manage reaches this; nobody sets their own department. */
export async function setPersonLocation(id: string, input: { departmentId: string | null; roomId: string | null; jobTitle?: string | null }): Promise<PersonView> {
  const user = await UserModel.findById(objectId(id, 'user'));
  if (!user || user.active === false) throw new HttpError(404, 'User not found');
  const location = input.departmentId || input.roomId ? await resolveLocation(input.departmentId, input.roomId) : null;
  user.set({ department: location?.departmentId ?? null, room: location?.roomId ?? null, ...(input.jobTitle !== undefined && { jobTitle: input.jobTitle }) });
  await user.save();
  return (await listPeople()).find((person) => person.id === user.id)!;
}
