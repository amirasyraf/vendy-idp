import { randomUUID } from 'node:crypto';
import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { parseEntityRef } from '@backstage/catalog-model';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import express from 'express';
import { azureReader } from './azure';
import {
  awsStorage,
  azureStorage,
  BucketStorage,
  maxWebBytes,
  MoveIncomplete,
  Platform,
  storageStatus,
} from './bucketStorage';

const buckets = 'buckets';
const audit = 'credential_issuance';
const bucketName = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
type Bucket = {
  id: string;
  request_id: string;
  name: string;
  team: string;
  platform: Platform;
  cloud_name: string;
  status: 'provisioning' | 'ready' | 'failed';
  requested_at?: Date | string | null;
  requested_by?: string | null;
};
type Caller = { user: string; teams: string[]; admin: boolean };

class Refusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const view = (bucket: Bucket) => ({
  id: bucket.id,
  name: bucket.name,
  team: bucket.team,
  platform: bucket.platform,
  status: bucket.status,
});
const allows = (caller: Caller, team: string) =>
  caller.admin || caller.teams.includes(team);
const platformOf = (input: unknown): Platform => {
  if (input === 'aws' || input === 'azure') return input;
  throw new Refusal(400, 'Choose AWS or Azure.');
};

function objectKey(input: unknown, isPrefix = false): string {
  if (
    typeof input !== 'string' ||
    (!input && !isPrefix) ||
    Buffer.byteLength(input) > 1024 ||
    /[\p{Cc}\\\uFFFD]/u.test(input) ||
    input.startsWith('/') ||
    input.includes('//') ||
    input.split('/').some(piece => piece === '.' || piece === '..') ||
    (!isPrefix && input.endsWith('/'))
  ) {
    throw new Refusal(
      400,
      'Use an object path without empty, dot, or parent folder segments.',
    );
  }
  return input;
}

function etagOf(input: unknown): string {
  if (typeof input !== 'string' || !/^"[\x21\x23-\x7e]{1,200}"$/.test(input))
    throw new Refusal(
      400,
      'Refresh the file list before modifying this object.',
    );
  return input;
}

export const bucketsPlugin = createBackendPlugin({
  pluginId: 'buckets',
  register(reg) {
    reg.registerInit({
      deps: {
        auth: coreServices.auth,
        config: coreServices.rootConfig,
        database: coreServices.database,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        catalog: catalogServiceRef,
      },
      async init({
        auth,
        config,
        database,
        httpAuth,
        httpRouter,
        logger,
        catalog,
      }) {
        const db = await database.getClient();
        if (!(await db.schema.hasTable(buckets))) {
          await db.schema.createTable(buckets, table => {
            table.uuid('id').primary();
            table.string('request_id', 100).notNullable().unique();
            table.string('name', 40).notNullable();
            table.string('team').notNullable();
            table.string('platform').notNullable();
            table.string('cloud_name', 63).notNullable().unique();
            table.string('status').notNullable();
            table.unique(['team', 'name']);
          });
        }
        const [hasRequestedAt, hasRequestedBy] = await Promise.all([
          db.schema.hasColumn(buckets, 'requested_at'),
          db.schema.hasColumn(buckets, 'requested_by'),
        ]);
        if (!hasRequestedAt || !hasRequestedBy) {
          await db.schema.alterTable(buckets, table => {
            if (!hasRequestedAt)
              table.timestamp('requested_at', { useTz: true });
            if (!hasRequestedBy) table.string('requested_by');
          });
        }
        if (!(await db.schema.hasTable(audit))) {
          await db.schema.createTable(audit, table => {
            table.uuid('id').primary();
            table
              .uuid('bucket_id')
              .notNullable()
              .references('id')
              .inTable(buckets);
            table.string('requested_by').notNullable();
            table.timestamp('issued_at').notNullable().defaultTo(db.fn.now());
            table.timestamp('expires_at').notNullable();
          });
        }

        const origin = new URL(config.getString('app.baseUrl')).origin;
        const region = process.env.AWS_REGION;
        const awsAccount = process.env.BUCKET_AWS_ACCOUNT;
        const uploadRole = process.env.BUCKET_AWS_UPLOAD_ROLE_ARN;
        const azureAccount = process.env.BUCKET_AZURE_ACCOUNT;
        const azureSecret = process.env.BUCKET_AZURE_SECRET_ID;
        const azureRegion = () =>
          azureReader().then(
            reader => reader.location,
            () => undefined,
          );
        const userView = (bucket: Bucket, location?: string) => ({
          ...view(bucket),
          region: bucket.platform === 'aws' ? region : location,
          requestedAt: bucket.requested_at,
          requestedBy: bucket.requested_by,
        });
        const providers: Partial<Record<Platform, BucketStorage>> = {
          aws:
            region && awsAccount && uploadRole
              ? awsStorage({ account: awsAccount, region, uploadRole, origin })
              : undefined,
          azure:
            region && azureAccount && azureSecret
              ? azureStorage({
                  account: azureAccount,
                  secretId: azureSecret,
                  region,
                })
              : undefined,
        };
        const providerFor = (platform: Platform) => {
          const provider = providers[platform];
          if (!provider)
            throw new Refusal(
              503,
              'Bucket infrastructure is unavailable for this cloud.',
            );
          return provider;
        };

        const service = await auth.getOwnServiceCredentials();
        const callerOf = async (req: express.Request): Promise<Caller> => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          const user = await catalog.getEntityByRef(principal.userEntityRef, {
            credentials: service,
          });
          if (user?.kind.toLowerCase() !== 'user')
            throw new Refusal(403, 'An active Vendy user is required.');
          const groups = user.spec?.memberOf;
          const teams = Array.isArray(groups)
            ? groups.flatMap(group => {
                if (typeof group !== 'string') return [];
                const ref = parseEntityRef(group, {
                  defaultKind: 'Group',
                  defaultNamespace: 'default',
                });
                return ref.kind.toLowerCase() === 'group' &&
                  ref.namespace.toLowerCase() === 'default'
                  ? [ref.name.toLowerCase()]
                  : [];
              })
            : [];
          return {
            user: principal.userEntityRef,
            teams,
            admin: teams.includes('platform-admins'),
          };
        };
        const owned = async (
          req: express.Request,
          caller: Caller,
          ready = true,
        ) => {
          const bucket = idPattern.test(req.params.id)
            ? await db<Bucket>(buckets).where({ id: req.params.id }).first()
            : undefined;
          if (!bucket || !allows(caller, bucket.team))
            throw new Refusal(404, 'Bucket not found.');
          if (ready && bucket.status !== 'ready')
            throw new Refusal(409, 'This bucket is not ready.');
          return bucket;
        };

        const running = new Map<string, Promise<void>>();
        async function provision(bucket: Bucket) {
          if (bucket.status === 'ready') return;
          let job = running.get(bucket.id);
          if (!job) {
            const provider = providerFor(bucket.platform);
            job = (async () => {
              await db<Bucket>(buckets)
                .where({ id: bucket.id })
                .update({ status: 'provisioning' });
              try {
                await provider.provision(bucket);
                await db<Bucket>(buckets)
                  .where({ id: bucket.id })
                  .update({ status: 'ready' });
              } catch (error) {
                await db<Bucket>(buckets)
                  .where({ id: bucket.id })
                  .update({ status: 'failed' });
                logger.warn('Bucket provisioning failed', {
                  bucketId: bucket.id,
                  platform: bucket.platform,
                  status: storageStatus(error),
                  errorType: error instanceof Error ? error.name : undefined,
                });
                throw new Refusal(
                  503,
                  'Bucket provisioning failed. Retry from the Bucket product page.',
                );
              } finally {
                running.delete(bucket.id);
              }
            })();
            running.set(bucket.id, job);
          }
          await job;
        }

        const router = express.Router();
        router.use(express.json({ limit: '32kb' }));
        router.use((_req, res, next) => {
          res.set('Cache-Control', 'no-store');
          next();
        });
        const route =
          (
            fn: (
              req: express.Request,
              res: express.Response,
            ) => Promise<unknown>,
          ): express.RequestHandler =>
          async (req, res, next) => {
            try {
              await fn(req, res);
            } catch (error) {
              if (error instanceof Refusal || error instanceof MoveIncomplete) {
                res
                  .status(error instanceof Refusal ? error.status : 409)
                  .json({ error: error.message });
                return;
              }
              if (
                error instanceof Error &&
                ['AuthenticationError', 'NotAllowedError'].includes(error.name)
              ) {
                next(error);
                return;
              }
              const status = storageStatus(error);
              if (status === 404) {
                res
                  .status(404)
                  .json({ error: 'Storage resource or file not found.' });
              } else if (status === 409 || status === 412) {
                res.status(409).json({
                  error:
                    'The source changed or the destination already exists. Refresh and try again.',
                });
              } else {
                // Provider errors can contain SAS URLs or credentials in request details.
                logger.warn('Bucket operation failed', {
                  route: req.route?.path,
                  method: req.method,
                  status,
                  errorType: error instanceof Error ? error.name : undefined,
                });
                res
                  .status(502)
                  .json({ error: 'The storage operation failed. Try again.' });
              }
            }
          };
        const userRoute = (
          fn: (
            req: express.Request,
            res: express.Response,
            caller: Caller,
          ) => Promise<unknown>,
        ) => route(async (req, res) => fn(req, res, await callerOf(req)));
        const objectRoute = (
          fn: (
            req: express.Request,
            res: express.Response,
            target: Bucket,
            provider: BucketStorage,
            caller: Caller,
          ) => Promise<unknown>,
        ) =>
          userRoute(async (req, res, caller) => {
            const target = await owned(req, caller);
            return fn(req, res, target, providerFor(target.platform), caller);
          });

        router.get(
          '/catalog',
          route(async (req, res) => {
            const { principal } = await httpAuth.credentials(req, {
              allow: ['service'],
            });
            if (principal.subject !== 'plugin:catalog')
              throw new Refusal(403, 'Catalog service required.');
            const rows = await db<Bucket>(buckets)
              .where({ status: 'ready' })
              .select();
            res.json(rows.map(view));
          }),
        );
        router.get(
          '/',
          userRoute(async (_req, res, caller) => {
            const selection = db<Bucket>(buckets).orderBy(['name', 'team']);
            if (!caller.admin) selection.whereIn('team', caller.teams);
            const rows = await selection;
            const location = rows.some(row => row.platform === 'azure')
              ? await azureRegion()
              : undefined;
            res.json({
              buckets: rows.map(row => userView(row, location)),
              platforms: {
                aws: Boolean(providers.aws),
                azure: Boolean(providers.azure),
              },
            });
          }),
        );
        router.post(
          '/',
          userRoute(async (req, res, caller) => {
            const { name, owner, requestId } = req.body ?? {};
            if (
              typeof name !== 'string' ||
              name.length < 3 ||
              name.length > 40 ||
              !bucketName.test(name)
            )
              throw new Refusal(
                400,
                'Use 3–40 lowercase letters, numbers, or single hyphens, starting with a letter.',
              );
            if (
              typeof requestId !== 'string' ||
              !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)
            )
              throw new Refusal(400, 'A valid request ID is required.');
            const team =
              typeof owner === 'string' &&
              /^group:default\/([a-z][a-z0-9-]*)$/.exec(owner)?.[1];
            if (!team || !allows(caller, team))
              throw new Refusal(
                403,
                'Choose a team you are allowed to manage.',
              );
            const group = await catalog.getEntityByRef(owner, {
              credentials: service,
            });
            if (group?.spec?.type !== 'team')
              throw new Refusal(400, 'Choose a Vendy team.');
            const platform = platformOf(req.body.platform);
            providerFor(platform);
            const id = randomUUID();
            await db<Bucket>(buckets)
              .insert({
                id,
                request_id: requestId,
                name,
                team,
                platform,
                status: 'provisioning',
                requested_at: new Date(),
                requested_by: caller.user,
                cloud_name:
                  platform === 'aws'
                    ? `cf-bucket-${awsAccount}-${id.replace(/-/g, '')}`
                    : `bucket-${id}`,
              })
              .onConflict()
              .ignore();
            const bucket = await db<Bucket>(buckets)
              .where({ request_id: requestId })
              .first();
            if (
              !bucket ||
              bucket.team !== team ||
              bucket.name !== name ||
              bucket.platform !== platform
            )
              throw new Refusal(
                409,
                'That team already has a bucket with this name or request ID.',
              );
            await provision(bucket);
            res.json({ id: bucket.id });
          }),
        );
        router.get(
          '/:id',
          userRoute(async (req, res, caller) => {
            const target = await owned(req, caller, false);
            const location =
              target.platform === 'azure' ? await azureRegion() : undefined;
            const storageUri =
              target.platform === 'aws'
                ? `s3://${target.cloud_name}`
                : azureAccount &&
                  `https://${azureAccount}.blob.core.windows.net/${target.cloud_name}`;
            res.json({
              ...userView(target, location),
              cloudName: target.cloud_name,
              storageUri,
            });
          }),
        );
        router.post(
          '/:id/retry',
          userRoute(async (req, res, caller) => {
            const bucket = await owned(req, caller, false);
            await provision(bucket);
            res.json({ id: bucket.id });
          }),
        );
        router.get(
          '/:id/usage',
          objectRoute(async (_req, res, target, provider) => {
            res.json(await provider.usage(target));
          }),
        );
        router.get(
          '/:id/objects',
          objectRoute(async (req, res, target, provider) => {
            const prefix = objectKey(req.query.prefix ?? '', true);
            const { cursor } = req.query;
            if (
              cursor !== undefined &&
              (typeof cursor !== 'string' || cursor.length > 8192)
            )
              throw new Refusal(400, 'Invalid file list cursor.');
            const result = await provider.list(target, prefix, cursor);
            res.json(result);
          }),
        );
        router.post(
          '/:id/upload',
          objectRoute(async (req, res, target, provider) => {
            const key = objectKey(req.body?.key);
            const size = req.body?.size;
            if (!Number.isSafeInteger(size) || size < 0 || size > maxWebBytes)
              throw new Refusal(
                400,
                'Browser uploads support files up to 4 GiB. Use CLI access for larger files.',
              );
            const current = await provider.stat(target, key);
            const expected =
              req.body?.etag === undefined ? undefined : etagOf(req.body.etag);
            if (current && !expected) {
              res.status(409).json({
                error: 'This file already exists.',
                existing: current,
              });
              return;
            }
            if (expected !== current?.etag)
              throw new Refusal(
                409,
                'This file changed. Refresh before replacing it.',
              );
            res.json(await provider.upload(target, key, size, expected));
          }),
        );
        router.post(
          '/:id/download',
          objectRoute(async (req, res, target, provider) => {
            const key = objectKey(req.body?.key);
            const preview = req.body?.preview === true;
            if (preview) {
              const current = await provider.stat(target, key);
              if (!current) throw new Refusal(404, 'File not found.');
              if (current.size > 5 * 1024 ** 2)
                throw new Refusal(400, 'Preview supports files up to 5 MiB.');
            }
            res.json(
              await provider.download(
                target,
                key,
                preview ? undefined : key.split('/').pop(),
              ),
            );
          }),
        );
        router.post(
          '/:id/remove',
          objectRoute(async (req, res, target, provider) => {
            await provider.remove(
              target,
              objectKey(req.body?.key),
              etagOf(req.body?.etag),
            );
            res.json({});
          }),
        );
        router.post(
          '/:id/move',
          objectRoute(async (req, res, target, provider) => {
            const key = objectKey(req.body?.key);
            const to = objectKey(req.body?.to);
            if (key === to)
              throw new Refusal(400, 'Choose a different destination path.');
            const etag = etagOf(req.body?.etag);
            const source = await provider.stat(target, key);
            if (!source || source.etag !== etag)
              throw new Refusal(
                409,
                'The source changed. Refresh before moving it.',
              );
            if (source.size > maxWebBytes)
              throw new Refusal(400, 'Web moves support files up to 4 GiB.');
            await provider.move(target, key, to, etag);
            res.json({});
          }),
        );
        router.post(
          '/:id/credentials',
          objectRoute(async (req, res, target, provider, caller) => {
            const minutes = req.body?.minutes;
            if (!Number.isInteger(minutes) || minutes < 15 || minutes > 480)
              throw new Refusal(
                400,
                'Choose an expiry from 15 minutes to 8 hours.',
              );
            const issuanceId = randomUUID();
            const credentials = await provider.issue(
              target,
              minutes,
              issuanceId,
            );
            await db(audit).insert({
              id: issuanceId,
              bucket_id: target.id,
              requested_by: caller.user,
              expires_at: credentials.expiresAt,
            });
            res.json(credentials);
          }),
        );
        httpRouter.use(router);
      },
    });
  },
});
