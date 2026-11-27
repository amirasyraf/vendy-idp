import { Entity } from '@backstage/catalog-model';

export const categories = [
  {
    id: 'compute',
    title: 'Compute',
    description: 'Run workloads on managed compute resources.',
  },
  {
    id: 'storage',
    title: 'Storage',
    description: 'Store and manage files for your team.',
  },
];

export const products = [
  {
    category: 'compute',
    id: 'virtual-machines',
    title: 'Virtual Machines',
    description: 'Launch and manage team-owned servers across platforms.',
    resourceType: 'vm',
    template: 'vm-request',
    launchFlow: 'platform-image',
  },
  {
    category: 'compute',
    id: 'containers',
    title: 'Containers',
    description: 'Run a container image on managed Kubernetes, with a public URL.',
    resourceType: 'container',
    template: 'container-request',
    launchFlow: 'platform',
  },
  {
    category: 'storage',
    id: 'bucket',
    title: 'Bucket',
    description: 'Create and manage private team storage on AWS or Azure.',
    resourceType: 'bucket',
    template: 'bucket-request',
    launchFlow: 'platform',
  },
];

type Product = (typeof products)[number];

export const launchPath = (product: Product) =>
  `/launch/${product.category}/${product.id}`;
export const productPath = (product: Product) =>
  `/products/${product.category}/${product.id}`;

export const virtualMachines = products[0];
export const containers = products[1];
export const bucket = products[2];
export const bucketPath = (id: string) => `${productPath(bucket)}/${id}`;
export const containerPlatforms = [
  { id: 'aws', label: 'AWS', available: true },
  { id: 'azure', label: 'Azure', available: true },
];

export const productOf = (entity: Entity) =>
  products.find(
    product =>
      entity.kind.toLowerCase() === 'resource' &&
      entity.spec?.type === product.resourceType,
  );
