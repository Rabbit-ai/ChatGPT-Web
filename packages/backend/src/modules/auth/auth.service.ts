import { compare, hashSync } from 'bcrypt';
import { Redis } from 'ioredis';
import * as Joi from 'joi';
import { CustomPrismaService } from 'nestjs-prisma';

import { InjectRedis } from '@liaoliaots/nestjs-redis';
import { Inject, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';

import { BizException } from '@/common/exceptions/biz.exception';
import { EmailService } from '@/libs/email/email.service';
import { JwtService } from '@/libs/jwt/jwt.service';
import { SmsService } from '@/libs/sms/sms.service';
import { ExtendedPrismaClient } from '@/processors/database/prisma.extension';

import { IAccountStatus } from 'shared';
import { ErrorCodeEnum } from 'shared/dist/error-code';

type ByPassword = {
  identity: string;
  password: string;
};

const SALT_ROUNDS = 10;

const emailSchema = Joi.string().email().required();
const phoneSchema = Joi.string()
  .pattern(/^[0-9]{11}$/)
  .required();

const getPhoneOrEmail = (identity: string) => {
  const emailValidation = emailSchema.validate(identity);
  const phoneValidation = phoneSchema.validate(identity);

  if (!emailValidation.error) {
    return { email: identity.trim().toLowerCase(), phone: undefined };
  } else if (!phoneValidation.error) {
    return { email: undefined, phone: identity.trim() };
  } else {
    throw Error('Invalid identity');
  }
};

function generateRandomSixDigitNumber() {
  const min = 100000;
  const max = 999999;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    @Inject('PrismaService')
    private prisma: CustomPrismaService<ExtendedPrismaClient>,
    private jwt: JwtService,
    private emailService: EmailService,
    private smsService: SmsService,
  ) {}

  /* 通常来说是最后一步：
   * 1. 检查是否绑定账户
   * 2. 检查是否设置密码
   */
  async #signWithCheck(user: any): Promise<{
    token: string;
    status: IAccountStatus;
  }> {
    let status: IAccountStatus = 'ok';
    if (!user.email && !user.phone) {
      status = 'bind';
    } else if (!user.password) {
      status = 'password';
    }
    return {
      token: await this.jwt.sign({ id: user.id, role: user.role }),
      status,
    };
  }

  async #verifyCode(identity: string, code: string) {
    const isValid = (await this.redis.get(identity)) === code;

    if (!isValid) {
      throw new BizException(ErrorCodeEnum.CodeValidationError);
    } else {
      await this.redis.del(identity);
    }
  }

  /* 添加验证码 */
  async newValidateCode(identity: string) {
    const { email, phone } = getPhoneOrEmail(identity);
    if (!email && !phone) {
      return {
        success: false,
      };
    }
    const ttl = await this.redis.ttl(identity);
    /* if key not exist, ttl will be -2 */
    if (600 - ttl < 60) {
      return {
        success: false,
        ttl,
      };
    } else {
      const newTtl = 10 * 60;
      const code = generateRandomSixDigitNumber();
      await this.redis.setex(identity, newTtl, code);

      if (email) {
        await this.emailService.sendCode(identity, code);
      } else if (phone) {
        await this.smsService.sendCode(identity, code);
      }
      return {
        success: true,
        ttl: newTtl,
      };
    }
  }

  /* 通过验证码登录/注册 */
  async WithValidateCode(identity: string, code: string) {
    const { email, phone } = getPhoneOrEmail(identity);

    await this.#verifyCode(identity, code);

    const existUser = await this.prisma.client.user.findMany({
      where: {
        OR: [{ email }, { phone }],
      },
    });

    let user;
    if (existUser.length != 1) {
      // 注册用户
      user = await this.prisma.client.user.create({
        data: {
          email: email,
          phone: phone,
          role: Role.User,
        },
      });
    } else {
      user = existUser[0];
    }
    return this.#signWithCheck(user);
  }

  /* 通过密码登录 */
  async loginPassword({ identity, password }: ByPassword) {
    const { email, phone } = getPhoneOrEmail(identity);

    const user = await this.prisma.client.user.findMany({
      where: {
        OR: [{ email }, { phone }],
      },
    });
    if (user.length != 1) {
      throw Error('User does not exist');
    }
    const isPasswordCorrect = await compare(password, user[0].password);
    if (!isPasswordCorrect) {
      throw Error('Password is incorrect');
    }
    return this.#signWithCheck(user[0]);
  }

  /* 添加密码 */
  async bindPassword(userId: number, password: string) {
    const user = await this.prisma.client.user.findUniqueOrThrow({
      where: {
        id: userId,
      },
    });
    if (user.password) {
      throw Error('Password already exists');
    }
    return await this.prisma.client.user.update({
      where: {
        id: userId,
      },
      data: {
        password: hashSync(password, SALT_ROUNDS),
      },
    });
  }

  async updateName(userId: number, name: string) {
    await this.prisma.client.user.update({
      where: {
        id: userId,
      },
      data: {
        name: name,
      },
    });
  }

  /* 修改密码 */
  async changePassword(userId: number, password: string) {
    await this.prisma.client.user.update({
      where: {
        id: userId,
      },
      data: {
        password: hashSync(password, SALT_ROUNDS),
      },
    });
  }

  /* 找回密码 */
  async forgetPassword(identity: string, code: string, password: string) {
    const { email, phone } = getPhoneOrEmail(identity);

    await this.#verifyCode(identity, code);

    const existUser = await this.prisma.client.user.findMany({
      where: {
        OR: [{ email }, { phone }],
      },
    });

    let user;
    if (existUser.length != 1) {
      throw new BizException(ErrorCodeEnum.UserNotExist);
    } else {
      user = existUser[0];
    }
    await this.changePassword(user.id, password);

    return this.#signWithCheck(user);
  }

  /* 绑定用户身份 */
  async bindIdentity(userId: number, identity: string, password?: string) {
    const { email, phone } = getPhoneOrEmail(identity);

    const user = await this.prisma.client.user.findUniqueOrThrow({
      where: {
        id: userId,
      },
    });

    if (email) {
      if (user.email) {
        throw new BizException(ErrorCodeEnum.BindEmailExist);
      }
      await this.prisma.client.user.update({
        where: {
          id: userId,
        },
        data: {
          email: email,
        },
      });
    }

    if (phone) {
      if (user.phone) {
        throw new BizException(ErrorCodeEnum.BindPhoneExist);
      }
      await this.prisma.client.user.update({
        where: {
          id: userId,
        },
        data: {
          phone: phone,
        },
      });
    }

    if (password) {
      await this.prisma.client.user.update({
        where: {
          id: userId,
        },
        data: {
          password: hashSync(password, SALT_ROUNDS),
        },
      });
    }
  }
}
