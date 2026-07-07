export interface ProductIdentity {
  displayName: string;
  description: string;
  commandName: string;
  packageName: string;
  mcpServerName: string;
  mcpToolPrefix: string;
  envPrefix: string;
  dataDirName: string;
  databaseFileName: string;
}

export interface ProductIdentityEnvironment {
  SOLIDKG_DISPLAY_NAME?: string;
}

function productDescription(displayName: string): string {
  return `${displayName}: code intelligence and knowledge graph for any codebase`;
}

export const DEFAULT_PRODUCT_IDENTITY: ProductIdentity = {
  displayName: 'SolidKG',
  description: productDescription('SolidKG'),
  commandName: 'solidkg',
  packageName: 'solidkg',
  mcpServerName: 'solidkg',
  mcpToolPrefix: 'solidkg',
  envPrefix: 'SOLIDKG',
  dataDirName: '.solidkg',
  databaseFileName: 'solidkg.db',
};

export function getProductIdentity(env: ProductIdentityEnvironment = process.env): ProductIdentity {
  const displayName = env.SOLIDKG_DISPLAY_NAME?.trim();
  if (!displayName) return DEFAULT_PRODUCT_IDENTITY;

  return {
    ...DEFAULT_PRODUCT_IDENTITY,
    displayName,
    description: productDescription(displayName),
  };
}
