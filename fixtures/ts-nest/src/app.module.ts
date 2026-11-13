import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AdminModule } from './admin/admin.module';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

@Module({
  imports: [AdminModule, RouterModule.register([{ path: 'admin', module: AdminModule }])],
  controllers: [UsersController],
  providers: [UsersService],
})
export class AppModule {}
