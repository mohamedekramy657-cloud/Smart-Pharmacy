import { Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthContext, CurrentAuth, Public } from '../../common/auth/decorators';
import { SessionService } from '../../common/auth/session.service';
import { Errors } from '../../common/errors';
import { ZBody } from '../../common/zod';
import { config } from '../../config/config';
import { Database } from '../../database/db';
import { OrganizationInputSchema, OrganizationsService } from '../organizations/organizations.service';
import { AuthService, LoginSchema, RegisterSchema, zPassword } from './auth.service';

const authLimit = () => ({ default: { limit: () => config().AUTH_RATE_LIMIT_PER_MINUTE, ttl: 60_000 } });

const RegisterOrgSchema = z.object({
  account: RegisterSchema.optional(),
  organization: OrganizationInputSchema,
}).strict();

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly orgs: OrganizationsService,
    private readonly db: Database,
  ) {}

  @Public()
  @Throttle(authLimit())
  @Post('register')
  async register(@ZBody(RegisterSchema) body: z.infer<typeof RegisterSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const user = await this.db.tx((tx) => this.auth.createUser(tx, body));
    const { token, csrf } = await this.sessions.create(user.id, false, req);
    this.sessions.setCookies(res, token, csrf);
    return { userId: user.id };
  }

  /** Business onboarding: creates (or reuses the signed-in) account + organization pending verification. */
  @Public()
  @Throttle(authLimit())
  @Post('register-organization')
  async registerOrganization(@ZBody(RegisterOrgSchema) body: z.infer<typeof RegisterOrgSchema>, @CurrentAuth() auth: AuthContext | null, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (!auth && !body.account) throw Errors.badRequest('account details are required when not signed in');
    const result = await this.db.tx(async (tx) => {
      const userId = auth?.user.id ?? (await this.auth.createUser(tx, body.account!)).id;
      const org = await this.orgs.create(tx, userId, body.organization);
      return { userId, organizationId: org.id };
    });
    if (!auth) {
      const { token, csrf } = await this.sessions.create(result.userId, false, req);
      this.sessions.setCookies(res, token, csrf);
    }
    return { ...result, verificationStatus: 'PENDING' };
  }

  @Public()
  @Throttle(authLimit())
  @Post('login')
  @HttpCode(200)
  async login(@ZBody(LoginSchema) body: z.infer<typeof LoginSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { token, csrf } = await this.auth.login(body, req);
    this.sessions.setCookies(res, token, csrf);
    const ctx = await this.sessions.authenticate({ ...req, cookies: { [this.sessions.sessionCookie]: token } } as Request);
    return this.auth.me(ctx);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(auth.sessionId, 'logout');
    this.sessions.clearCookies(res);
    return { ok: true };
  }

  @Public()
  @Get('me')
  me(@CurrentAuth() auth: AuthContext | null) {
    return this.auth.me(auth);
  }

  @Post('mfa/setup')
  @HttpCode(200)
  mfaSetup(@CurrentAuth() auth: AuthContext) {
    return this.auth.setupMfa(auth);
  }

  @Post('mfa/enable')
  @HttpCode(200)
  async mfaEnable(@CurrentAuth() auth: AuthContext, @ZBody(z.object({ code: z.string().regex(/^\d{6}$/) }).strict()) body: { code: string }) {
    await this.auth.enableMfa(auth, body.code);
    return { mfaEnabled: true };
  }

  @Throttle(authLimit())
  @Post('password')
  @HttpCode(200)
  async changePassword(@CurrentAuth() auth: AuthContext, @ZBody(z.object({ currentPassword: z.string().min(1).max(128), newPassword: zPassword }).strict()) body: { currentPassword: string; newPassword: string }) {
    await this.auth.changePassword(auth, body.currentPassword, body.newPassword);
    return { ok: true };
  }
}
