import { UserInfoService } from '@backstage/backend-plugin-api';
import {
  catalogConditions,
  createCatalogConditionalDecision,
} from '@backstage/plugin-catalog-backend/alpha';
import {
  AuthorizeResult,
  isResourcePermission,
  PolicyDecision,
} from '@backstage/plugin-permission-common';
import {
  PermissionPolicy,
  PolicyQuery,
  PolicyQueryUser,
} from '@backstage/plugin-permission-node';
import {
  scaffolderTaskConditions,
  createScaffolderTaskConditionalDecision,
} from '@backstage/plugin-scaffolder-backend/alpha';

export class ComputeFactoryPolicy implements PermissionPolicy {
  constructor(private readonly userInfo: UserInfoService) {}

  async handle(
    request: PolicyQuery,
    user?: PolicyQueryUser,
  ): Promise<PolicyDecision> {
    const info = user
      ? await this.userInfo.getUserInfo(user.credentials)
      : undefined;
    const claims = info?.ownershipEntityRefs ?? [];
    if (claims.includes('group:default/platform-admins')) {
      return { result: AuthorizeResult.ALLOW };
    }
    const name = request.permission.name;
    if (
      [
        'catalog.entity.delete',
        'catalog.location.create',
        'catalog.location.delete',
      ].includes(name)
    ) {
      return { result: AuthorizeResult.DENY };
    }
    if (isResourcePermission(request.permission, 'catalog-entity')) {
      return createCatalogConditionalDecision(request.permission, {
        anyOf: [
          {
            // Team-owned products: VMs and containers are visible to their team only.
            not: {
              allOf: [
                catalogConditions.isEntityKind({ kinds: ['Resource'] }),
                {
                  anyOf: [
                    catalogConditions.hasSpec({ key: 'type', value: 'vm' }),
                    catalogConditions.hasSpec({
                      key: 'type',
                      value: 'container',
                    }),
                  ],
                },
              ],
            },
          },
          catalogConditions.isEntityOwner({ claims }),
        ],
      });
    }
    if (
      isResourcePermission(request.permission, 'scaffolder-task') &&
      ['scaffolder.task.read', 'scaffolder.task.cancel'].includes(name)
    ) {
      return createScaffolderTaskConditionalDecision(
        request.permission,
        scaffolderTaskConditions.isTaskOwner({
          createdBy: info ? [info.userEntityRef] : [],
        }),
      );
    }
    return { result: AuthorizeResult.ALLOW };
  }
}
