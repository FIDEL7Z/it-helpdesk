import { HttpError } from '../errors/http-error';
import { UserModel, toPublicUser, type PublicUser } from '../models/user.model';
import { comparePassword, hashPassword } from '../utils/password';
import { signAccessToken } from '../utils/jwt';

export interface LoginResult {
  token: string;
  user: PublicUser;
}

// Compared against when the email does not exist, so both failure cases take
// about the same time and the response does not reveal which accounts exist.
const dummyPasswordHash = hashPassword('dummy-password-for-timing');

export async function login(email: string, password: string): Promise<LoginResult> {
  const user = await UserModel.findOne({ email }).select('+passwordHash');
  const passwordMatches = await comparePassword(
    password,
    user?.passwordHash ?? (await dummyPasswordHash),
  );

  if (!user || !user.active || !passwordMatches) {
    throw new HttpError(401, 'Invalid email or password');
  }

  return {
    token: signAccessToken(user.id),
    user: toPublicUser(user),
  };
}
