import { describe, expect, it } from 'vitest';
import { DEFAULT_PRODUCT_IDENTITY, getProductIdentity } from '../src/branding';

describe('branding identity', () => {
  it('returns the SolidKG compatibility defaults', () => {
    const identity = getProductIdentity({});

    expect(identity).toEqual(DEFAULT_PRODUCT_IDENTITY);
    expect(identity).toMatchObject({
      displayName: 'SolidKG',
      commandName: 'solidkg',
      packageName: 'solidkg',
      mcpServerName: 'solidkg',
      mcpToolPrefix: 'solidkg',
      envPrefix: 'SOLIDKG',
      dataDirName: '.solidkg',
      databaseFileName: 'solidkg.db',
    });
  });

  it('applies display-name override without changing compatibility identifiers', () => {
    const identity = getProductIdentity({ SOLIDKG_DISPLAY_NAME: 'Acquirer Graph' });

    expect(identity.displayName).toBe('Acquirer Graph');
    expect(identity.description).toContain('Acquirer Graph');
    expect(identity).toMatchObject({
      commandName: 'solidkg',
      packageName: 'solidkg',
      mcpServerName: 'solidkg',
      mcpToolPrefix: 'solidkg',
      envPrefix: 'SOLIDKG',
      dataDirName: '.solidkg',
      databaseFileName: 'solidkg.db',
    });
  });
});
