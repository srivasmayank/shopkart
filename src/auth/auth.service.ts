import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async signup(email: string, password: string) {
    const passwordHash = await bcrypt.hash(password, 12);

    try {
      const user = await this.prisma.user.create({
        data: { email, passwordHash, role: Role.CUSTOMER },
      });
      return this.issueToken(user.id, user.role);
    } catch (e: any) {
      if (e.code === 'P2002') {
        throw new ConflictException('Email already registered');
      }
      throw e;
    }
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    const ok = user && (await bcrypt.compare(password, user.passwordHash));

    if (!ok) {
      // Same error message for unknown email or wrong password to prevent user enumeration
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.issueToken(user.id, user.role);
  }

  private issueToken(userId: number, role: Role) {
    return {
      accessToken: this.jwt.sign({ sub: userId, role }),
    };
  }
}

