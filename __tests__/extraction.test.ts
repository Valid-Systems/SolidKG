/**
 * Extraction Tests
 *
 * Tests for the tree-sitter extraction system.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SolidKG } from '../src';
import {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  LARGE_FILE_FRESH_WORKER_BYTES,
  extractFromSource,
  parseTimeoutMsForContentLength,
  scanDirectory,
  scanDirectoryAsync,
  shouldRecycleWorkerForLargeFile,
} from '../src/extraction';
import { detectLanguage, isLanguageSupported, getSupportedLanguages, initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { normalizePath } from '../src/utils';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

// Create a temporary directory for each test
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'solidkg-test-'));
}

// Clean up temporary directory
function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Language Detection', () => {
  it('should detect TypeScript files', () => {
    expect(detectLanguage('src/index.ts')).toBe('typescript');
    expect(detectLanguage('src/index.mts')).toBe('typescript');
    expect(detectLanguage('src/index.cts')).toBe('typescript');
    expect(detectLanguage('components/Button.tsx')).toBe('tsx');
  });

  it('should detect JavaScript files', () => {
    expect(detectLanguage('index.js')).toBe('javascript');
    expect(detectLanguage('App.jsx')).toBe('jsx');
    expect(detectLanguage('config.mjs')).toBe('javascript');
    expect(detectLanguage('config.cjs')).toBe('javascript');
  });

  it('should detect Python files', () => {
    expect(detectLanguage('main.py')).toBe('python');
  });

  it('should detect Go files', () => {
    expect(detectLanguage('main.go')).toBe('go');
  });

  it('should detect Rust files', () => {
    expect(detectLanguage('lib.rs')).toBe('rust');
  });

  it('should detect Java files', () => {
    expect(detectLanguage('Main.java')).toBe('java');
  });

  it('should detect C files', () => {
    expect(detectLanguage('main.c')).toBe('c');
    expect(detectLanguage('utils.h')).toBe('c');
  });

  it('should detect C++ files', () => {
    expect(detectLanguage('main.cpp')).toBe('cpp');
    expect(detectLanguage('class.hpp')).toBe('cpp');
    expect(detectLanguage('kernel.cu')).toBe('cpp');
    expect(detectLanguage('kernel.cuh')).toBe('cpp');
  });

  it('should detect C# files', () => {
    expect(detectLanguage('Program.cs')).toBe('csharp');
  });

  it('should detect Solidity files', () => {
    expect(detectLanguage('contracts/Vault.sol')).toBe('solidity');
  });

  it('should detect HCL/Terraform and Nix files', () => {
    expect(detectLanguage('infra/main.tf')).toBe('hcl');
    expect(detectLanguage('infra/nomad.hcl')).toBe('hcl');
    expect(detectLanguage('flake.nix')).toBe('nix');
  });

  it('should detect PHP files', () => {
    expect(detectLanguage('index.php')).toBe('php');
  });

  it('should detect Ruby files', () => {
    expect(detectLanguage('app.rb')).toBe('ruby');
  });

  it('should detect Swift files', () => {
    expect(detectLanguage('ViewController.swift')).toBe('swift');
  });

  it('should detect Kotlin files', () => {
    expect(detectLanguage('MainActivity.kt')).toBe('kotlin');
    expect(detectLanguage('build.gradle.kts')).toBe('kotlin');
  });

  it('should detect Dart files', () => {
    expect(detectLanguage('main.dart')).toBe('dart');
  });

  it('should detect Objective-C files', () => {
    expect(detectLanguage('AppDelegate.m')).toBe('objc');
    expect(detectLanguage('ViewController.mm')).toBe('objc');
    const objcHeader = '@interface Foo : NSObject\n@end\n';
    expect(detectLanguage('Foo.h', objcHeader)).toBe('objc');
    expect(detectLanguage('stdio.h', '#ifndef STDIO_H\nvoid printf();\n#endif\n')).toBe('c');
  });

  it('should detect Groovy and VB.NET files', () => {
    expect(detectLanguage('src/main/groovy/App.groovy')).toBe('groovy');
    expect(detectLanguage('build.gradle')).toBe('groovy');
    expect(detectLanguage('scripts/setup.gvy')).toBe('groovy');
    expect(detectLanguage('legacy/Report.vb')).toBe('vbnet');
  });

  it('should detect hardware and scientific language files', () => {
    expect(detectLanguage('rtl/adder.v')).toBe('systemverilog');
    expect(detectLanguage('rtl/adder.sv')).toBe('systemverilog');
    expect(detectLanguage('rtl/defs.svh')).toBe('systemverilog');
    expect(detectLanguage('src/Stats.jl')).toBe('julia');
    expect(detectLanguage('src/linalg.f90')).toBe('fortran');
    expect(detectLanguage('src/legacy.for')).toBe('fortran');
    expect(detectLanguage('analysis/model.R')).toBe('r');
  });

  it('should detect ArkTS and PLC SCL files', () => {
    expect(detectLanguage('entry/src/main/ets/pages/Index.ets')).toBe('arkts');
    expect(detectLanguage('plc/Conveyor.scl')).toBe('scl');
  });

  it('should detect hybrid template files', () => {
    expect(detectLanguage('src/pages/index.astro')).toBe('astro');
    expect(detectLanguage('templates/index.html')).toBe('jinja');
    expect(detectLanguage('templates/card.jinja2')).toBe('jinja');
    expect(detectLanguage('Views/Home/Index.cshtml')).toBe('razor');
  });

  it('should return unknown for unsupported extensions', () => {
    expect(detectLanguage('styles.css')).toBe('unknown');
    expect(detectLanguage('data.json')).toBe('unknown');
  });
});

describe('Language Support', () => {
  it('should report supported languages', () => {
    expect(isLanguageSupported('typescript')).toBe(true);
    expect(isLanguageSupported('python')).toBe(true);
    expect(isLanguageSupported('go')).toBe(true);
    expect(isLanguageSupported('unknown')).toBe(false);
  });

  it('should list all supported languages', () => {
    const languages = getSupportedLanguages();
    expect(languages).toContain('typescript');
    expect(languages).toContain('javascript');
    expect(languages).toContain('python');
    expect(languages).toContain('go');
    expect(languages).toContain('rust');
    expect(languages).toContain('java');
    expect(languages).toContain('csharp');
    expect(languages).toContain('php');
    expect(languages).toContain('ruby');
    expect(languages).toContain('swift');
    expect(languages).toContain('kotlin');
    expect(languages).toContain('dart');
    expect(languages).toContain('groovy');
    expect(languages).toContain('vbnet');
    expect(languages).toContain('systemverilog');
    expect(languages).toContain('julia');
    expect(languages).toContain('fortran');
    expect(languages).toContain('r');
    expect(languages).toContain('hcl');
    expect(languages).toContain('nix');
    expect(languages).toContain('arkts');
    expect(languages).toContain('scl');
  });
});

describe('Parse Worker Recycling', () => {
  it('should recycle before large files only after the worker has prior parses', () => {
    expect(shouldRecycleWorkerForLargeFile(LARGE_FILE_FRESH_WORKER_BYTES - 1, 10)).toBe(false);
    expect(shouldRecycleWorkerForLargeFile(LARGE_FILE_FRESH_WORKER_BYTES, 0)).toBe(false);
    expect(shouldRecycleWorkerForLargeFile(LARGE_FILE_FRESH_WORKER_BYTES, 1)).toBe(true);
  });

  it('caps per-file parse timeouts for pathological generated fixtures', () => {
    expect(parseTimeoutMsForContentLength(50_000)).toBe(10_000);
    expect(parseTimeoutMsForContentLength(250_000)).toBe(30_000);
    expect(parseTimeoutMsForContentLength(5 * 1024 * 1024 - 1)).toBe(30_000);
  });
});

describe('ArkTS Extraction', () => {
  it('should extract Harmony-style components, classes, functions, imports, and calls', () => {
    const code = `
import router from '@ohos.router';
import { preferences } from '@kit.ArkData';

export function formatMessage(value: string): string {
  return value.trim();
}

export class MessageStore {
  load(): string {
    return formatMessage('hello');
  }
}

@Entry
@Component
struct Index {
  @State message: string = 'Hello';

  build() {
    Column() {
      Text(this.message).fontSize(24);
      this.openDetails();
    }
  }

  private openDetails(): void {
    router.pushUrl({ url: 'pages/Details' });
  }
}
`;
    const result = extractFromSource('entry/src/main/ets/pages/Index.ets', code);

    expect(result.errors).toHaveLength(0);
    expect(result.nodes.some((n) => n.kind === 'file' && n.language === 'arkts')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'import' && n.name === '@ohos.router')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'import' && n.name === '@kit.ArkData')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'function' && n.name === 'formatMessage')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'MessageStore')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'component' && n.name === 'Index')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'method' && n.name === 'build')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'variable' && n.name === 'message')).toBe(true);
    expect(result.unresolvedReferences.some((r) => r.referenceKind === 'imports' && r.referenceName === '@ohos.router')).toBe(true);
    expect(result.unresolvedReferences.some((r) => r.referenceKind === 'calls' && r.referenceName === 'formatMessage')).toBe(true);
    expect(result.unresolvedReferences.some((r) => r.referenceKind === 'calls' && r.referenceName === 'openDetails')).toBe(true);
    expect(result.unresolvedReferences.some((r) => r.referenceKind === 'calls' && r.referenceName === 'pushUrl')).toBe(true);
  });
});

describe('PLC SCL Extraction', () => {
  it('should extract PLC blocks, functions, variables, and calls', () => {
    const code = `
FUNCTION StartMotor : BOOL
VAR_INPUT
  Enable : BOOL;
END_VAR
  StartMotor := Enable;
END_FUNCTION

FUNCTION_BLOCK ConveyorControl
VAR_INPUT
  StartButton : BOOL;
END_VAR
VAR
  Running : BOOL;
END_VAR
  Running := StartMotor(Enable := StartButton);
END_FUNCTION_BLOCK

ORGANIZATION_BLOCK Main
  ConveyorControl(StartButton := TRUE);
END_ORGANIZATION_BLOCK
`;
    const result = extractFromSource('plc/Conveyor.scl', code);

    expect(result.errors).toHaveLength(0);
    expect(result.nodes.some((n) => n.kind === 'file' && n.language === 'scl')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'function' && n.name === 'StartMotor')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'ConveyorControl')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'Main')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'variable' && n.name === 'Enable')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'variable' && n.name === 'Running')).toBe(true);
    expect(result.unresolvedReferences.some((r) => r.referenceKind === 'calls' && r.referenceName === 'StartMotor')).toBe(true);
    expect(result.unresolvedReferences.some((r) => r.referenceKind === 'calls' && r.referenceName === 'ConveyorControl')).toBe(true);
  });
});

describe('HCL/Terraform Extraction', () => {
  it('should extract Terraform blocks, module sources, locals, and references', () => {
    const code = `
variable "region" {
  type = string
}

locals {
  bucket_name = "logs-\${var.region}"
}

module "network" {
  source = "./modules/network"
}

resource "aws_s3_bucket" "logs" {
  bucket = local.bucket_name
  tags = {
    Vpc = module.network.vpc_id
  }
}

output "bucket_id" {
  value = aws_s3_bucket.logs.id
}
`;
    const result = extractFromSource('infra/main.tf', code);

    expect(result.errors).toHaveLength(0);
    expect(result.nodes.some((n) => n.language === 'hcl' && n.kind === 'variable' && n.name === 'variable.region')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'module' && n.name === 'module.network')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'component' && n.name === 'resource.aws_s3_bucket.logs')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'export' && n.name === 'output.bucket_id')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'variable' && n.name === 'bucket_name')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'import' && n.name === './modules/network')).toBe(true);

    const refs = result.unresolvedReferences.map((r) => `${r.referenceKind}:${r.referenceName}`);
    expect(refs).toContain('imports:./modules/network');
    expect(refs).toContain('references:local.bucket_name');
    expect(refs).toContain('references:module.network.vpc_id');
    expect(refs).toContain('references:aws_s3_bucket.logs.id');
  });

  it('should extract generic HCL blocks and attributes without Terraform evaluation', () => {
    const code = `
service {
  name = "api"
  address = "127.0.0.1"
}
`;
    const result = extractFromSource('nomad.hcl', code);

    expect(result.errors).toHaveLength(0);
    expect(result.nodes.some((n) => n.language === 'hcl' && n.kind === 'module' && n.name === 'service')).toBe(true);
  });
});

describe('Nix Extraction', () => {
  it('should extract Nix bindings, functions, imports, and references', () => {
    const code = `
{ pkgs ? import <nixpkgs> { }, lib ? pkgs.lib }:

let
  greet = name: "hello \${name}";
  overlay = final: prev: {
    myTool = prev.callPackage ./pkgs/my-tool { };
  };
in
{
  imports = [ ./hardware-configuration.nix ./modules/web.nix ];
  services.nginx.enable = true;
  environment.systemPackages = with pkgs; [ git ripgrep ];
  message = greet "solidkg";
  nixpkgs.overlays = [ overlay ];
}
`;
    const result = extractFromSource('default.nix', code);

    expect(result.errors).toHaveLength(0);
    expect(result.nodes.some((n) => n.language === 'nix' && n.kind === 'function' && n.name === 'greet')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'function' && n.name === 'overlay')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'variable' && n.name === 'services.nginx.enable')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'variable' && n.name === 'message')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'import' && n.name === './hardware-configuration.nix')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'import' && n.name === './modules/web.nix')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'import' && n.name === '<nixpkgs>')).toBe(true);

    const refs = result.unresolvedReferences.map((r) => `${r.referenceKind}:${r.referenceName}`);
    expect(refs).toContain('imports:./hardware-configuration.nix');
    expect(refs).toContain('imports:./modules/web.nix');
    expect(refs).toContain('imports:<nixpkgs>');
    expect(refs).toContain('calls:greet');
    expect(refs).toContain('references:overlay');
  });
});

describe('TypeScript Extraction', () => {
  it('should preserve identifier text after UTF-8 multi-byte characters', () => {
    // Given: identifiers following both a non-BMP emoji and a multi-byte BMP character.
    const code = '/* 😀 */ const after = 1;\nconst café = after;';

    // When: native Tree-sitter positions are projected back into JavaScript source text.
    const result = extractFromSource('unicode.ts', code);

    // Then: byte columns do not corrupt the UTF-16 source slices.
    const constants = result.nodes.filter((node) => node.kind === 'constant');
    expect(constants.map((node) => node.name)).toEqual(['after', 'café']);
    expect(constants.find((node) => node.name === 'after')).toMatchObject({
      startColumn: 15,
      endColumn: 24,
    });
    expect(constants.find((node) => node.name === 'café')).toMatchObject({
      startColumn: 6,
      endColumn: 18,
    });
  });

  it('should parse explicit TypeScript module extensions', () => {
    const mts = extractFromSource('module.mts', 'export function loadConfig() { return 1; }');
    const cts = extractFromSource('module.cts', 'export function loadLegacyConfig() { return 2; }');

    expect(mts.errors).toHaveLength(0);
    expect(cts.errors).toHaveLength(0);
    expect(mts.nodes.some((n) => n.kind === 'function' && n.name === 'loadConfig')).toBe(true);
    expect(cts.nodes.some((n) => n.kind === 'function' && n.name === 'loadLegacyConfig')).toBe(true);
  });

  it('should extract function declarations', () => {
    const code = `
export function processPayment(amount: number): Promise<Receipt> {
  return stripe.charge(amount);
}
`;
    const result = extractFromSource('payment.ts', code);

    // File node + function node
    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode?.name).toBe('payment.ts');

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'processPayment',
      language: 'typescript',
      isExported: true,
    });
    expect(funcNode?.signature).toContain('amount: number');
  });

  it('should extract class declarations', () => {
    const code = `
export class PaymentService {
  private stripe: StripeClient;

  constructor(apiKey: string) {
    this.stripe = new StripeClient(apiKey);
  }

  async charge(amount: number): Promise<Receipt> {
    return this.stripe.charge(amount);
  }
}
`;
    const result = extractFromSource('service.ts', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    const methodNodes = result.nodes.filter((n) => n.kind === 'method');

    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('PaymentService');
    expect(classNode?.isExported).toBe(true);

    expect(methodNodes.length).toBeGreaterThanOrEqual(1);
    const chargeMethod = methodNodes.find((m) => m.name === 'charge');
    expect(chargeMethod).toBeDefined();
  });

  it('should extract private class fields while preserving arrow-function class fields as methods', () => {
    const code = `
class Ky {
  readonly #startTime: number | undefined;

  public getRemainingTotalTimeout = (): number | undefined => {
    return this.#startTime;
  };
}
`;
    const result = extractFromSource('source/core/Ky.ts', code);

    const startTime = result.nodes.find((n) => n.kind === 'field' && n.name === '#startTime');
    expect(startTime).toBeDefined();
    expect(startTime?.signature).toContain('readonly #startTime: number | undefined');
    expect(startTime?.startLine).toBe(3);
    expect(startTime?.filePath).toBe('source/core/Ky.ts');

    expect(result.nodes.find((n) => n.kind === 'method' && n.name === 'getRemainingTotalTimeout')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'field' && n.name === 'getRemainingTotalTimeout')).toBeUndefined();
  });

  it('should extract interfaces', () => {
    const code = `
export interface User {
  id: string;
  name: string;
  email: string;
}
`;
    const result = extractFromSource('types.ts', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
    expect(ifaceNode).toMatchObject({
      kind: 'interface',
      name: 'User',
      isExported: true,
    });
  });

  it('should track function calls', () => {
    const code = `
function main() {
  const result = processData();
  console.log(result);
}
`;
    const result = extractFromSource('main.ts', code);

    expect(result.unresolvedReferences.length).toBeGreaterThan(0);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((c) => c.referenceName === 'processData')).toBe(true);
  });
});

describe('Arrow Function Export Extraction', () => {
  it('should extract exported arrow functions assigned to const', () => {
    const code = `
export const useAuth = (): AuthContextValue => {
  return useContext(AuthContext);
};
`;
    const result = extractFromSource('hooks.ts', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'useAuth');
    expect(funcNode).toBeDefined();
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'useAuth',
      isExported: true,
    });
  });

  it('should extract exported function expressions assigned to const', () => {
    const code = `
export const processData = function(input: string): string {
  return input.trim();
};
`;
    const result = extractFromSource('utils.ts', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'processData');
    expect(funcNode).toBeDefined();
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'processData',
      isExported: true,
    });
  });

  it('should not extract non-exported arrow functions as exported', () => {
    const code = `
const internalHelper = () => {
  return 42;
};
`;
    const result = extractFromSource('internal.ts', code);

    const helperNode = result.nodes.find((n) => n.name === 'internalHelper');
    expect(helperNode).toBeDefined();
    expect(helperNode?.isExported).toBeFalsy();
  });

  it('should still skip truly anonymous arrow functions', () => {
    const code = `
const items = [1, 2, 3].map((x) => x * 2);
`;
    const result = extractFromSource('anon.ts', code);

    // The inline arrow function passed to .map() has no variable_declarator parent
    // and should remain anonymous (skipped)
    const anonFunctions = result.nodes.filter(
      (n) => n.kind === 'function' && n.name === '<anonymous>'
    );
    expect(anonFunctions).toHaveLength(0);
  });

  it('should extract multiple exported arrow functions from the same file', () => {
    const code = `
export const add = (a: number, b: number): number => a + b;

export const subtract = (a: number, b: number): number => a - b;

const internal = () => 'not exported';
`;
    const result = extractFromSource('math.ts', code);

    const exported = result.nodes.filter((n) => n.kind === 'function' && n.isExported);
    expect(exported).toHaveLength(2);
    expect(exported.map((n) => n.name).sort()).toEqual(['add', 'subtract']);

    const internalNode = result.nodes.find((n) => n.name === 'internal');
    expect(internalNode).toBeDefined();
    expect(internalNode?.isExported).toBeFalsy();
  });

  it('should extract arrow functions in JavaScript files', () => {
    const code = `
export const fetchData = async () => {
  const response = await fetch('/api/data');
  return response.json();
};
`;
    const result = extractFromSource('api.js', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'fetchData');
    expect(funcNode).toBeDefined();
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'fetchData',
      isExported: true,
    });
  });
});

describe('Type Alias Extraction', () => {
  it('should extract exported type aliases in TypeScript', () => {
    const code = `
export type AuthContextValue = {
  user: User | null;
  login: () => void;
  logout: () => void;
};
`;
    const result = extractFromSource('types.ts', code);

    const typeNode = result.nodes.find((n) => n.kind === 'type_alias');
    expect(typeNode).toMatchObject({
      kind: 'type_alias',
      name: 'AuthContextValue',
      isExported: true,
    });
  });

  it('should extract non-exported type aliases', () => {
    const code = `
type InternalState = {
  loading: boolean;
  error: string | null;
};
`;
    const result = extractFromSource('internal.ts', code);

    const typeNode = result.nodes.find((n) => n.kind === 'type_alias');
    expect(typeNode).toMatchObject({
      kind: 'type_alias',
      name: 'InternalState',
      isExported: false,
    });
  });

  it('should extract multiple type aliases from the same file', () => {
    const code = `
export type UnitSystem = 'metric' | 'imperial';
export type DateFormat = 'ISO' | 'US' | 'EU';
type Internal = string;
`;
    const result = extractFromSource('config.ts', code);

    const typeAliases = result.nodes.filter((n) => n.kind === 'type_alias');
    expect(typeAliases).toHaveLength(3);

    const exported = typeAliases.filter((n) => n.isExported);
    expect(exported).toHaveLength(2);
    expect(exported.map((n) => n.name).sort()).toEqual(['DateFormat', 'UnitSystem']);
  });
});

describe('Exported Variable Extraction', () => {
  it('should extract exported const with call expression (Zustand store)', () => {
    const code = `
export const useUIStore = create<UIState>((set) => ({
  isOpen: false,
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));
`;
    const result = extractFromSource('store.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'useUIStore');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract exported const with object literal', () => {
    const code = `
export const config = {
  apiUrl: 'https://api.example.com',
  timeout: 5000,
};
`;
    const result = extractFromSource('config.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'config');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract exported const with array literal', () => {
    const code = `
export const SCREEN_NAMES = ['home', 'settings', 'profile'] as const;
`;
    const result = extractFromSource('constants.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'SCREEN_NAMES');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract exported const with primitive value', () => {
    const code = `
export const MAX_RETRIES = 3;
export const API_VERSION = "v2";
`;
    const result = extractFromSource('constants.ts', code);

    const variables = result.nodes.filter((n) => n.kind === 'constant');
    expect(variables).toHaveLength(2);
    expect(variables.map((n) => n.name).sort()).toEqual(['API_VERSION', 'MAX_RETRIES']);
  });

  it('should NOT duplicate arrow functions as both function and variable', () => {
    const code = `
export const useAuth = () => {
  return useContext(AuthContext);
};
`;
    const result = extractFromSource('hooks.ts', code);

    // Should be extracted as function (from arrow function handler), NOT as variable
    const funcNodes = result.nodes.filter((n) => n.kind === 'function' && n.name === 'useAuth');
    const varNodes = result.nodes.filter((n) => n.kind === 'variable' && n.name === 'useAuth');
    expect(funcNodes).toHaveLength(1);
    expect(varNodes).toHaveLength(0);
  });

  it('should extract non-exported const as non-exported variable', () => {
    const code = `
const internalConfig = {
  debug: true,
};
`;
    const result = extractFromSource('internal.ts', code);

    // Non-exported const at file level should be extracted as a constant (not exported)
    const varNodes = result.nodes.filter((n) => (n.kind === 'variable' || n.kind === 'constant') && n.name === 'internalConfig');
    expect(varNodes).toHaveLength(1);
    expect(varNodes[0]?.isExported).toBeFalsy();
  });

  it('should extract Zod schema exports', () => {
    const code = `
export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});
`;
    const result = extractFromSource('schemas.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'userSchema');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract XState machine exports', () => {
    const code = `
export const authMachine = createMachine({
  id: "auth",
  initial: "idle",
  states: {
    idle: {},
    authenticated: {},
  },
});
`;
    const result = extractFromSource('machine.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'authMachine');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });
});

describe('File Node Extraction', () => {
  it('should create a file-kind node for each parsed file', () => {
    const code = `
export function greet(name: string): string {
  return "Hello " + name;
}
`;
    const result = extractFromSource('greeter.ts', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode?.name).toBe('greeter.ts');
    expect(fileNode?.filePath).toBe('greeter.ts');
    expect(fileNode?.language).toBe('typescript');
    expect(fileNode?.startLine).toBe(1);
  });

  it('should create file nodes for Python files', () => {
    const code = `
def main():
    pass
`;
    const result = extractFromSource('main.py', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode?.name).toBe('main.py');
    expect(fileNode?.language).toBe('python');
  });

  it('should create containment edges from file node to top-level declarations', () => {
    const code = `
export function foo() {}
export function bar() {}
`;
    const result = extractFromSource('fns.ts', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();

    // There should be contains edges from the file node to each function
    const containsEdges = result.edges.filter(
      (e) => e.source === fileNode?.id && e.kind === 'contains'
    );
    expect(containsEdges.length).toBeGreaterThanOrEqual(2);
  });
});

describe('JavaScript Extraction', () => {
  it('should extract private class fields while preserving arrow-function class fields as methods', () => {
    const code = `
class Ky {
  #startTime;

  getRemainingTotalTimeout = () => {
    return this.#startTime;
  };
}
`;
    const result = extractFromSource('source/core/Ky.js', code);

    expect(result.nodes.find((n) => n.kind === 'field' && n.name === '#startTime')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'method' && n.name === 'getRemainingTotalTimeout')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'field' && n.name === 'getRemainingTotalTimeout')).toBeUndefined();
  });
});

describe('Python Extraction', () => {
  it('should extract function definitions', () => {
    const code = `
def calculate_total(items: list, tax_rate: float) -> float:
    """Calculate total with tax."""
    subtotal = sum(item.price for item in items)
    return subtotal * (1 + tax_rate)
`;
    const result = extractFromSource('calc.py', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'calculate_total',
      language: 'python',
    });
  });

  it('should extract class definitions', () => {
    const code = `
class UserService:
    """Service for managing users."""

    def __init__(self, db):
        self.db = db

    def get_user(self, user_id: str) -> User:
        return self.db.find_user(user_id)
`;
    const result = extractFromSource('service.py', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserService');
  });
});

describe('Go Extraction', () => {
  it('should extract function declarations', () => {
    const code = `
package main

func ProcessOrder(order Order) (Receipt, error) {
    // Process the order
    return Receipt{}, nil
}
`;
    const result = extractFromSource('main.go', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('ProcessOrder');
  });

  it('should extract method declarations', () => {
    const code = `
package main

type Service struct {
    db *Database
}

func (s *Service) GetUser(id string) (*User, error) {
    return s.db.FindUser(id)
}
`;
    const result = extractFromSource('service.go', code);

    const methodNode = result.nodes.find((n) => n.kind === 'method');
    expect(methodNode).toBeDefined();
    expect(methodNode?.name).toBe('GetUser');
  });
});

describe('Rust Extraction', () => {
  it('should extract function declarations', () => {
    const code = `
pub fn process_data(input: &str) -> Result<Output, Error> {
    // Process data
    Ok(Output::new())
}
`;
    const result = extractFromSource('lib.rs', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('process_data');
    expect(funcNode?.visibility).toBe('public');
  });

  it('should extract struct declarations', () => {
    const code = `
pub struct User {
    pub id: String,
    pub name: String,
    email: String,
}
`;
    const result = extractFromSource('models.rs', code);

    const structNode = result.nodes.find((n) => n.kind === 'struct');
    expect(structNode).toBeDefined();
    expect(structNode?.name).toBe('User');
  });

  it('should extract trait declarations', () => {
    const code = `
pub trait Repository {
    fn find(&self, id: &str) -> Option<Entity>;
    fn save(&mut self, entity: Entity) -> Result<(), Error>;
}
`;
    const result = extractFromSource('traits.rs', code);

    const traitNode = result.nodes.find((n) => n.kind === 'trait');
    expect(traitNode).toBeDefined();
    expect(traitNode?.name).toBe('Repository');
  });

  it('should extract impl Trait for Type as implements edges', () => {
    const code = `
pub struct MyCache {}

pub trait Cache {
    fn get(&self, key: &str) -> Option<String>;
}

impl Cache for MyCache {
    fn get(&self, key: &str) -> Option<String> {
        None
    }
}
`;
    const result = extractFromSource('cache.rs', code);

    // Should have an unresolved reference for implements
    const implRef = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'implements' && r.referenceName === 'Cache'
    );
    expect(implRef).toBeDefined();

    // The struct MyCache should be the source
    const myCacheNode = result.nodes.find((n) => n.name === 'MyCache' && n.kind === 'struct');
    expect(myCacheNode).toBeDefined();
    expect(implRef?.fromNodeId).toBe(myCacheNode?.id);
  });

  it('should extract trait supertraits as extends references', () => {
    const code = `
pub trait Display {}

pub trait Error: Display {
    fn description(&self) -> &str;
}
`;
    const result = extractFromSource('error.rs', code);

    const extendsRef = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'extends' && r.referenceName === 'Display'
    );
    expect(extendsRef).toBeDefined();

    const errorTrait = result.nodes.find((n) => n.name === 'Error' && n.kind === 'trait');
    expect(errorTrait).toBeDefined();
    expect(extendsRef?.fromNodeId).toBe(errorTrait?.id);
  });

  it('should not create implements edges for plain impl blocks', () => {
    const code = `
pub struct Counter {
    count: u32,
}

impl Counter {
    pub fn new() -> Counter {
        Counter { count: 0 }
    }
    pub fn increment(&mut self) {
        self.count += 1;
    }
}
`;
    const result = extractFromSource('counter.rs', code);

    // Should have no implements references (no trait involved)
    const implRefs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'implements'
    );
    expect(implRefs).toHaveLength(0);
  });
});

describe('Java Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
public class UserService {
    private final UserRepository repository;

    public UserService(UserRepository repository) {
        this.repository = repository;
    }

    public User getUser(String id) {
        return repository.findById(id);
    }
}
`;
    const result = extractFromSource('UserService.java', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserService');
    expect(classNode?.visibility).toBe('public');
  });

  it('should extract method declarations', () => {
    const code = `
public class Calculator {
    public static int add(int a, int b) {
        return a + b;
    }
}
`;
    const result = extractFromSource('Calculator.java', code);

    const methodNode = result.nodes.find((n) => n.kind === 'method' && n.name === 'add');
    expect(methodNode).toBeDefined();
    expect(methodNode?.isStatic).toBe(true);
  });
});

describe('C# Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
public class OrderService
{
    private readonly IOrderRepository _repository;

    public OrderService(IOrderRepository repository)
    {
        _repository = repository;
    }

    public async Task<Order> GetOrderAsync(string id)
    {
        return await _repository.FindByIdAsync(id);
    }
}
`;
    const result = extractFromSource('OrderService.cs', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('OrderService');
    expect(classNode?.visibility).toBe('public');
  });

  it('should extract C# primary-constructor classes and members', () => {
    const code = `
public partial class UserService(ILogger<UserService> logger, IOptions<AppOptions> options) : BaseService(options.Value.Name)
{
    private readonly ILogger<UserService> _logger = logger;

    public void Handle(string input)
    {
        _logger.LogInformation(input);
    }
}
`;
    const result = extractFromSource('UserService.cs', code);

    const classNode = result.nodes.find((n) => n.kind === 'class' && n.name === 'UserService');
    const methodNode = result.nodes.find((n) => n.kind === 'method' && n.name === 'Handle');
    expect(result.errors).toHaveLength(0);
    expect(classNode).toBeDefined();
    expect(classNode?.visibility).toBe('public');
    expect(methodNode).toBeDefined();
    expect(methodNode?.qualifiedName).toBe('UserService::Handle');
  });
});

describe('Solidity Extraction', () => {
  it('should extract contracts, interfaces, libraries, events, modifiers, state variables, inheritance, and static calls', () => {
    const code = `
pragma solidity ^0.8.20;

import { IERC20 } from "./IERC20.sol";

interface IVault {
    event Deposited(address indexed user, uint256 amount);
    function deposit(uint256 amount) external;
}

library SafeMathLike {
    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        return a + b;
    }
}

contract Ownable {
    address public owner;
    modifier onlyOwner() {
        require(msg.sender == owner, "owner");
        _;
    }
}

contract Vault is Ownable, IVault {
    IERC20 private token;
    uint256 public totalAssets;
    event Withdrawn(address indexed user, uint256 amount);
    error InsufficientBalance(address user, uint256 requested);

    modifier nonZero(uint256 amount) {
        require(amount > 0, "zero");
        _;
    }

    function deposit(uint256 amount) external override nonZero(amount) {
        _pull(msg.sender, amount);
        totalAssets = SafeMathLike.add(totalAssets, amount);
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonZero(amount) {
        if (amount > totalAssets) revert InsufficientBalance(msg.sender, amount);
        _send(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function _pull(address from, uint256 amount) internal {
        token.transferFrom(from, address(this), amount);
    }

    function _send(address to, uint256 amount) internal {
        token.transfer(to, amount);
    }
}
`;

    const result = extractFromSource('Vault.sol', code);
    expect(result.errors).toHaveLength(0);

    expect(result.nodes.filter((n) => n.kind === 'class').map((n) => n.name)).toEqual(
      expect.arrayContaining(['Ownable', 'Vault', 'SafeMathLike'])
    );
    expect(result.nodes.find((n) => n.kind === 'interface' && n.name === 'IVault')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'import' && n.name === './IERC20.sol')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'field' && n.name === 'totalAssets')).toBeDefined();

    const methodNames = result.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
    expect(methodNames).toEqual(expect.arrayContaining([
      'Deposited',
      'InsufficientBalance',
      'Withdrawn',
      '_pull',
      '_send',
      'deposit',
      'nonZero',
      'onlyOwner',
      'withdraw',
    ]));

    const vault = result.nodes.find((n) => n.kind === 'class' && n.name === 'Vault');
    const extendsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'extends');
    expect(extendsRefs.map((r) => r.referenceName)).toEqual(expect.arrayContaining(['Ownable', 'IVault']));
    expect(extendsRefs.every((r) => r.fromNodeId === vault?.id)).toBe(true);

    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.map((r) => r.referenceName)).toEqual(expect.arrayContaining([
      'Deposited',
      'InsufficientBalance',
      'SafeMathLike.add',
      'Withdrawn',
      '_pull',
      '_send',
      'token.transfer',
      'token.transferFrom',
    ]));

    const modifiers = result.unresolvedReferences.filter((r) => r.referenceKind === 'decorates');
    expect(modifiers.map((r) => r.referenceName)).toContain('nonZero');
  });
});

describe('PHP Extraction', () => {
  it('should extract class declarations', () => {
    const code = `<?php

class UserController
{
    private UserService $userService;

    public function __construct(UserService $userService)
    {
        $this->userService = $userService;
    }

    public function show(string $id): User
    {
        return $this->userService->find($id);
    }
}
`;
    const result = extractFromSource('UserController.php', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserController');
  });

  it('should extract class inheritance (extends) and interface implementation', () => {
    const code = `<?php

class ChildController extends BaseController implements Serializable, JsonSerializable
{
    public function serialize(): string
    {
        return json_encode($this);
    }
}
`;
    const result = extractFromSource('ChildController.php', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('ChildController');

    const extendsRef = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'extends'
    );
    expect(extendsRef).toBeDefined();
    expect(extendsRef?.referenceName).toBe('BaseController');

    const implementsRefs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'implements'
    );
    expect(implementsRefs.length).toBe(2);
    expect(implementsRefs.map((r) => r.referenceName)).toContain('Serializable');
    expect(implementsRefs.map((r) => r.referenceName)).toContain('JsonSerializable');
  });
});

describe('Swift Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
public class NetworkManager {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func fetchData(from url: URL) async throws -> Data {
        let (data, _) = try await session.data(from: url)
        return data
    }
}
`;
    const result = extractFromSource('NetworkManager.swift', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('NetworkManager');
  });

  it('should extract function declarations', () => {
    const code = `
func calculateSum(_ numbers: [Int]) -> Int {
    return numbers.reduce(0, +)
}

public func formatCurrency(amount: Double) -> String {
    return String(format: "$%.2f", amount)
}
`;
    const result = extractFromSource('utils.swift', code);

    const functions = result.nodes.filter((n) => n.kind === 'function');
    expect(functions.length).toBeGreaterThanOrEqual(1);
  });

  it('should extract struct declarations', () => {
    const code = `
public struct User {
    let id: UUID
    var name: String
    var email: String

    func displayName() -> String {
        return name
    }
}
`;
    const result = extractFromSource('User.swift', code);

    const structNode = result.nodes.find((n) => n.kind === 'struct');
    expect(structNode).toBeDefined();
    expect(structNode?.name).toBe('User');
  });

  it('should extract protocol declarations', () => {
    const code = `
public protocol Repository {
    associatedtype Entity

    func find(id: String) async throws -> Entity?
    func save(_ entity: Entity) async throws
}
`;
    const result = extractFromSource('Repository.swift', code);

    const protocolNode = result.nodes.find((n) => n.kind === 'interface');
    expect(protocolNode).toBeDefined();
    expect(protocolNode?.name).toBe('Repository');
  });

  it('should extract class inheritance and protocol conformance', () => {
    const code = `
class DataRequest: Request {
    func validate() {}
}

class UploadRequest: DataRequest, Sendable {
    func upload() {}
}

enum AFError: Error {
    case invalidURL
}

struct HTTPMethod: RawRepresentable {
    let rawValue: String
}

protocol UploadConvertible: URLRequestConvertible {
    func asURLRequest() throws -> URLRequest
}
`;
    const result = extractFromSource('Inheritance.swift', code);

    const extendsRefs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'extends'
    );

    // DataRequest extends Request
    expect(extendsRefs.find((r) => r.referenceName === 'Request')).toBeDefined();
    // UploadRequest extends DataRequest and Sendable
    expect(extendsRefs.find((r) => r.referenceName === 'DataRequest')).toBeDefined();
    expect(extendsRefs.find((r) => r.referenceName === 'Sendable')).toBeDefined();
    // AFError extends Error
    expect(extendsRefs.find((r) => r.referenceName === 'Error')).toBeDefined();
    // HTTPMethod extends RawRepresentable
    expect(extendsRefs.find((r) => r.referenceName === 'RawRepresentable')).toBeDefined();
    // UploadConvertible extends URLRequestConvertible
    expect(extendsRefs.find((r) => r.referenceName === 'URLRequestConvertible')).toBeDefined();
  });
});

describe('Kotlin Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
class UserRepository(private val database: Database) {
    fun findById(id: String): User? {
        return database.query("SELECT * FROM users WHERE id = ?", id)
    }

    suspend fun save(user: User) {
        database.insert(user)
    }
}
`;
    const result = extractFromSource('UserRepository.kt', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserRepository');
  });

  it('should extract function declarations', () => {
    const code = `
fun calculateTotal(items: List<Item>): Double {
    return items.sumOf { it.price }
}

suspend fun fetchUserData(userId: String): User {
    return api.getUser(userId)
}
`;
    const result = extractFromSource('utils.kt', code);

    const functions = result.nodes.filter((n) => n.kind === 'function');
    expect(functions.length).toBeGreaterThanOrEqual(1);
  });

  it('should detect suspend functions as async', () => {
    const code = `
suspend fun loadData(): List<String> {
    delay(1000)
    return listOf("a", "b", "c")
}
`;
    const result = extractFromSource('loader.kt', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.isAsync).toBe(true);
  });

  it('should extract fun interface declarations', () => {
    const code = `
fun interface OnObjectRetainedListener {
  fun onObjectRetained()
}
`;
    const result = extractFromSource('listener.kt', code);

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
    expect(ifaceNode).toBeDefined();
    expect(ifaceNode?.name).toBe('OnObjectRetainedListener');

    const methodNode = result.nodes.find((n) => n.kind === 'method');
    expect(methodNode).toBeDefined();
    expect(methodNode?.name).toBe('onObjectRetained');
    expect(methodNode?.qualifiedName).toBe('OnObjectRetainedListener::onObjectRetained');
  });

  it('should extract complex fun interface with nested classes', () => {
    const code = `
fun interface EventListener {
  fun onEvent(event: Event)

  sealed class Event {
    class DumpingHeap : Event()
  }
}
`;
    const result = extractFromSource('events.kt', code);

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
    expect(ifaceNode).toBeDefined();
    expect(ifaceNode?.name).toBe('EventListener');

    // Nested sealed class should still be extracted (as sibling due to grammar limitations)
    const eventClass = result.nodes.find((n) => n.kind === 'class' && n.name === 'Event');
    expect(eventClass).toBeDefined();

    const dumpingHeap = result.nodes.find((n) => n.kind === 'class' && n.name === 'DumpingHeap');
    expect(dumpingHeap).toBeDefined();
  });

  it('should not affect regular function declarations', () => {
    const code = `
fun interface MyCallback {
  fun invoke(value: Int)
}

fun regularFunction(): String {
  return "hello"
}
`;
    const result = extractFromSource('mixed.kt', code);

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
    expect(ifaceNode).toBeDefined();
    expect(ifaceNode?.name).toBe('MyCallback');

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('regularFunction');
  });

  it('should extract fun interface with annotation on method (Pattern 2b)', () => {
    // When the SAM method has annotations like @Throws, tree-sitter produces a different
    // misparse: function_declaration > ERROR("interface Name {") instead of
    // function_declaration > user_type("interface"). This is the OkHttp Interceptor pattern.
    const code = `
import java.io.IOException

fun interface Interceptor {
  @Throws(IOException::class)
  fun intercept(chain: Chain): Response
}
`;
    const result = extractFromSource('interceptor.kt', code);

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
    expect(ifaceNode).toBeDefined();
    expect(ifaceNode?.name).toBe('Interceptor');
  });

  it('should extract methods from interface with nested fun interface', () => {
    // When an interface contains a nested `fun interface`, tree-sitter misparsed
    // the parent body as ERROR. Methods inside should still be extracted.
    const code = `
interface WebSocket {
  fun request(): Request
  fun send(text: String): Boolean
  fun cancel()
  fun interface Factory {
    fun newWebSocket(request: Request): WebSocket
  }
}
`;
    const result = extractFromSource('websocket.kt', code);

    const wsIface = result.nodes.find((n) => n.kind === 'interface' && n.name === 'WebSocket');
    expect(wsIface).toBeDefined();

    const methods = result.nodes.filter((n) => n.kind === 'method' && n.qualifiedName?.startsWith('WebSocket::'));
    const methodNames = methods.map((m) => m.name);
    expect(methodNames).toContain('request');
    expect(methodNames).toContain('send');
    expect(methodNames).toContain('cancel');
  });
});

describe('Dart Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
class UserService {
  final Database _db;

  Future<User> findById(String id) async {
    return await _db.query(id);
  }

  void _privateMethod() {}
}
`;
    const result = extractFromSource('service.dart', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserService');
    expect(classNode?.visibility).toBe('public');

    const methodNodes = result.nodes.filter((n) => n.kind === 'method');
    expect(methodNodes.length).toBeGreaterThanOrEqual(2);

    const findById = methodNodes.find((m) => m.name === 'findById');
    expect(findById).toBeDefined();
    expect(findById?.isAsync).toBe(true);

    const privateMethod = methodNodes.find((m) => m.name === '_privateMethod');
    expect(privateMethod).toBeDefined();
    expect(privateMethod?.visibility).toBe('private');

    // Dart models a method body as a SIBLING of the signature, so the method
    // node must be extended to span its body (not just the signature line) —
    // required for body-level analysis (callees, the callback synthesizer).
    expect(findById!.endLine).toBeGreaterThan(findById!.startLine);
  });

  it('should extract top-level function declarations', () => {
    const code = `
void topLevelFunction(String name) {
  print(name);
}
`;
    const result = extractFromSource('utils.dart', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('topLevelFunction');
    expect(funcNode?.language).toBe('dart');
  });

  it('should extract enum declarations', () => {
    const code = `
enum Status { active, inactive, pending }
`;
    const result = extractFromSource('models.dart', code);

    const enumNode = result.nodes.find((n) => n.kind === 'enum');
    expect(enumNode).toBeDefined();
    expect(enumNode?.name).toBe('Status');
  });

  it('should extract mixin declarations', () => {
    const code = `
mixin LoggerMixin {
  void log(String message) {}
}
`;
    const result = extractFromSource('mixins.dart', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('LoggerMixin');

    const methodNode = result.nodes.find((n) => n.kind === 'method');
    expect(methodNode).toBeDefined();
    expect(methodNode?.name).toBe('log');
  });

  it('should extract extension declarations', () => {
    const code = `
extension StringExt on String {
  bool get isBlank => trim().isEmpty;
}
`;
    const result = extractFromSource('extensions.dart', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('StringExt');
  });

  it('should detect static methods', () => {
    const code = `
class Utils {
  static void doWork() {}
}
`;
    const result = extractFromSource('utils.dart', code);

    const methodNode = result.nodes.find((n) => n.kind === 'method');
    expect(methodNode).toBeDefined();
    expect(methodNode?.name).toBe('doWork');
    expect(methodNode?.isStatic).toBe(true);
  });

  it('should detect async functions', () => {
    const code = `
Future<String> fetchData() async {
  return await http.get('/data');
}
`;
    const result = extractFromSource('api.dart', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('fetchData');
    expect(funcNode?.isAsync).toBe(true);
  });

  it('should detect private visibility via underscore convention', () => {
    const code = `
void _privateHelper() {}

void publicFunction() {}
`;
    const result = extractFromSource('helpers.dart', code);

    const functions = result.nodes.filter((n) => n.kind === 'function');
    const privateFunc = functions.find((f) => f.name === '_privateHelper');
    const publicFunc = functions.find((f) => f.name === 'publicFunction');

    expect(privateFunc?.visibility).toBe('private');
    expect(publicFunc?.visibility).toBe('public');
  });
});

describe('Import Extraction', () => {
  describe('TypeScript/JavaScript imports', () => {
    it('should extract default imports', () => {
      const code = `import React from 'react';`;
      const result = extractFromSource('app.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('react');
      expect(importNode?.signature).toBe("import React from 'react';");
    });

    it('should extract named imports', () => {
      const code = `import { Bug, Database } from '@phosphor-icons/react';`;
      const result = extractFromSource('icons.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('@phosphor-icons/react');
      expect(importNode?.signature).toContain('Bug');
      expect(importNode?.signature).toContain('Database');
    });

    it('should extract namespace imports', () => {
      const code = `import * as Icons from '@phosphor-icons/react';`;
      const result = extractFromSource('icons.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('@phosphor-icons/react');
      expect(importNode?.signature).toContain('* as Icons');
    });

    it('should extract side-effect imports', () => {
      const code = `import './styles.css';`;
      const result = extractFromSource('app.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('./styles.css');
    });

    it('should extract mixed imports (default + named)', () => {
      const code = `import React, { useState, useEffect } from 'react';`;
      const result = extractFromSource('app.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('react');
      expect(importNode?.signature).toContain('React');
      expect(importNode?.signature).toContain('useState');
      expect(importNode?.signature).toContain('useEffect');
    });

    it('should extract multiple import statements', () => {
      const code = `
import React from 'react';
import { Button } from './components';
import './styles.css';
`;
      const result = extractFromSource('app.tsx', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('react');
      expect(names).toContain('./components');
      expect(names).toContain('./styles.css');
    });

    it('should extract type imports', () => {
      const code = `import type { FC, ReactNode } from 'react';`;
      const result = extractFromSource('types.ts', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('react');
      expect(importNode?.signature).toContain('type');
      expect(importNode?.signature).toContain('FC');
    });

    it('should extract aliased named imports', () => {
      const code = `import { useState as useStateAlias } from 'react';`;
      const result = extractFromSource('hooks.ts', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('react');
      expect(importNode?.signature).toContain('useState');
      expect(importNode?.signature).toContain('useStateAlias');
    });

    it('should extract relative path imports', () => {
      const code = `import { helper } from '../utils/helper';`;
      const result = extractFromSource('components/Button.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('../utils/helper');
      expect(importNode?.signature).toContain('helper');
    });
  });

  describe('Python imports', () => {
    it('should extract simple import statement', () => {
      const code = `import json`;
      const result = extractFromSource('utils.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('json');
    });

    it('should extract from import statement', () => {
      const code = `from os import path`;
      const result = extractFromSource('utils.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('os');
      expect(importNode?.signature).toContain('path');
    });

    it('should extract multiple imports from same module', () => {
      const code = `from typing import List, Dict, Optional`;
      const result = extractFromSource('types.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('typing');
      expect(importNode?.signature).toContain('List');
      expect(importNode?.signature).toContain('Dict');
    });

    it('should extract multiple import statements', () => {
      const code = `
import os
import sys
`;
      const result = extractFromSource('main.py', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(2);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('os');
      expect(names).toContain('sys');
    });

    it('should extract aliased import', () => {
      const code = `import numpy as np`;
      const result = extractFromSource('data.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('numpy');
      expect(importNode?.signature).toContain('as np');
    });

    it('should extract relative import', () => {
      const code = `from .utils import helper`;
      const result = extractFromSource('module.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('.utils');
      expect(importNode?.signature).toContain('helper');
    });

    it('should extract wildcard import', () => {
      const code = `from typing import *`;
      const result = extractFromSource('types.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('typing');
      expect(importNode?.signature).toContain('*');
    });
  });

  describe('Rust imports', () => {
    it('should extract simple use declaration', () => {
      const code = `use std::io;`;
      const result = extractFromSource('main.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('std');
      expect(importNode?.signature).toBe('use std::io;');
    });

    it('should extract scoped use list', () => {
      const code = `use std::{ffi::OsStr, io, path::Path};`;
      const result = extractFromSource('main.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('std');
      expect(importNode?.signature).toContain('ffi::OsStr');
      expect(importNode?.signature).toContain('path::Path');
    });

    it('should extract crate imports', () => {
      const code = `use crate::error::Error;`;
      const result = extractFromSource('lib.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('crate');
    });

    it('should extract super imports', () => {
      const code = `use super::utils;`;
      const result = extractFromSource('submod.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('super');
    });

    it('should extract external crate imports', () => {
      const code = `use serde::{Serialize, Deserialize};`;
      const result = extractFromSource('types.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('serde');
      expect(importNode?.signature).toContain('Serialize');
      expect(importNode?.signature).toContain('Deserialize');
    });
  });

  describe('Go imports', () => {
    it('should extract single import', () => {
      const code = `
package main

import "fmt"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('fmt');
    });

    it('should extract grouped imports', () => {
      const code = `
package main

import (
	"fmt"
	"os"
	"encoding/json"
)
`;
      const result = extractFromSource('main.go', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('fmt');
      expect(names).toContain('os');
      expect(names).toContain('encoding/json');
    });

    it('should extract aliased import', () => {
      const code = `
package main

import f "fmt"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('fmt');
      expect(importNode?.signature).toContain('f');
    });

    it('should extract dot import', () => {
      const code = `
package main

import . "math"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('math');
      expect(importNode?.signature).toContain('.');
    });

    it('should extract blank import', () => {
      const code = `
package main

import _ "github.com/go-sql-driver/mysql"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('github.com/go-sql-driver/mysql');
      expect(importNode?.signature).toContain('_');
    });
  });

  describe('Swift imports', () => {
    it('should extract simple import', () => {
      const code = `import Foundation`;
      const result = extractFromSource('main.swift', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Foundation');
      expect(importNode?.signature).toBe('import Foundation');
    });

    it('should extract @testable import', () => {
      const code = `@testable import Alamofire`;
      const result = extractFromSource('Tests.swift', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Alamofire');
      expect(importNode?.signature).toContain('@testable');
    });

    it('should extract @preconcurrency import', () => {
      const code = `@preconcurrency import Security`;
      const result = extractFromSource('Auth.swift', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Security');
    });

    it('should extract multiple imports', () => {
      const code = `
import Foundation
import UIKit
import Alamofire
`;
      const result = extractFromSource('App.swift', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('Foundation');
      expect(names).toContain('UIKit');
      expect(names).toContain('Alamofire');
    });
  });

  describe('Kotlin imports', () => {
    it('should extract simple import', () => {
      const code = `import java.io.IOException`;
      const result = extractFromSource('Main.kt', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.io.IOException');
      expect(importNode?.signature).toBe('import java.io.IOException');
    });

    it('should extract aliased import', () => {
      const code = `import okhttp3.Request.Builder as RequestBuilder`;
      const result = extractFromSource('Utils.kt', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('okhttp3.Request.Builder');
      expect(importNode?.signature).toContain('as RequestBuilder');
    });

    it('should extract wildcard import', () => {
      const code = `import java.util.concurrent.TimeUnit.*`;
      const result = extractFromSource('Time.kt', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.concurrent.TimeUnit');
      expect(importNode?.signature).toContain('.*');
    });

    it('should extract multiple imports', () => {
      const code = `
import java.io.IOException
import kotlin.test.assertFailsWith
import okhttp3.OkHttpClient
`;
      const result = extractFromSource('Test.kt', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('java.io.IOException');
      expect(names).toContain('kotlin.test.assertFailsWith');
      expect(names).toContain('okhttp3.OkHttpClient');
    });
  });

  describe('Java imports', () => {
    it('should extract simple import', () => {
      const code = `import java.util.List;`;
      const result = extractFromSource('Main.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.List');
      expect(importNode?.signature).toBe('import java.util.List;');
    });

    it('should extract static import', () => {
      const code = `import static java.util.Collections.emptyList;`;
      const result = extractFromSource('Utils.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.Collections.emptyList');
      expect(importNode?.signature).toContain('static');
    });

    it('should extract wildcard import', () => {
      const code = `import java.util.*;`;
      const result = extractFromSource('App.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util');
      expect(importNode?.signature).toContain('.*');
    });

    it('should extract nested class import', () => {
      const code = `import java.util.Map.Entry;`;
      const result = extractFromSource('MapUtil.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.Map.Entry');
    });

    it('should extract multiple imports', () => {
      const code = `
import java.util.List;
import java.util.Map;
import java.io.IOException;
`;
      const result = extractFromSource('Service.java', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('java.util.List');
      expect(names).toContain('java.util.Map');
      expect(names).toContain('java.io.IOException');
    });
  });

  describe('C# imports', () => {
    it('should extract simple using', () => {
      const code = `using System;`;
      const result = extractFromSource('Program.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System');
      expect(importNode?.signature).toBe('using System;');
    });

    it('should extract qualified using', () => {
      const code = `using System.Collections.Generic;`;
      const result = extractFromSource('Utils.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System.Collections.Generic');
    });

    it('should extract static using', () => {
      const code = `using static System.Console;`;
      const result = extractFromSource('App.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System.Console');
      expect(importNode?.signature).toContain('static');
    });

    it('should extract alias using', () => {
      const code = `using MyList = System.Collections.Generic.List<int>;`;
      const result = extractFromSource('Types.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System.Collections.Generic.List<int>');
      expect(importNode?.signature).toContain('MyList =');
    });

    it('should extract multiple usings', () => {
      const code = `
using System;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
`;
      const result = extractFromSource('Service.cs', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('System');
      expect(names).toContain('System.Threading.Tasks');
      expect(names).toContain('Microsoft.Extensions.DependencyInjection');
    });
  });

  describe('PHP imports', () => {
    it('should extract simple use', () => {
      const code = `<?php use PHPUnit\\Framework\\TestCase;`;
      const result = extractFromSource('Test.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('PHPUnit\\Framework\\TestCase');
    });

    it('should extract aliased use', () => {
      const code = `<?php use Mockery as m;`;
      const result = extractFromSource('Test.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Mockery');
      expect(importNode?.signature).toContain('as m');
    });

    it('should extract function use', () => {
      const code = `<?php use function Illuminate\\Support\\env;`;
      const result = extractFromSource('helpers.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Illuminate\\Support\\env');
      expect(importNode?.signature).toContain('function');
    });

    it('should extract grouped use', () => {
      const code = `<?php use Illuminate\\Database\\{Model, Builder};`;
      const result = extractFromSource('Models.php', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(2);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('Illuminate\\Database\\Model');
      expect(names).toContain('Illuminate\\Database\\Builder');
    });

    it('should extract multiple uses', () => {
      const code = `<?php
use Illuminate\\Support\\Collection;
use Illuminate\\Support\\Str;
use Closure;
`;
      const result = extractFromSource('Service.php', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('Illuminate\\Support\\Collection');
      expect(names).toContain('Illuminate\\Support\\Str');
      expect(names).toContain('Closure');
    });
  });

  describe('Ruby imports', () => {
    it('should extract require', () => {
      const code = `require 'json'`;
      const result = extractFromSource('app.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('json');
      expect(importNode?.signature).toBe("require 'json'");
    });

    it('should extract require with path', () => {
      const code = `require 'active_support/core_ext/string'`;
      const result = extractFromSource('config.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('active_support/core_ext/string');
    });

    it('should extract require_relative', () => {
      const code = `require_relative '../test_helper'`;
      const result = extractFromSource('test/my_test.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('../test_helper');
      expect(importNode?.signature).toContain('require_relative');
    });

    it('should not extract non-require calls', () => {
      const code = `puts 'hello'`;
      const result = extractFromSource('app.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeUndefined();
    });

    it('should extract multiple requires', () => {
      const code = `
require 'json'
require 'yaml'
require_relative 'helper'
`;
      const result = extractFromSource('lib.rb', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('json');
      expect(names).toContain('yaml');
      expect(names).toContain('helper');
    });
  });

  describe('Ruby modules', () => {
    it('should extract module as module node with containment', () => {
      const code = `
module CachedCounting
  def self.disable
    @enabled = false
  end

  def perform_increment!(key, count)
    write_cache!(key, count)
  end
end
`;
      const result = extractFromSource('concerns/cached_counting.rb', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module' && n.name === 'CachedCounting');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.qualifiedName).toBe('CachedCounting');

      // Methods inside module should have module-qualified names
      const disableMethod = result.nodes.find((n) => n.name === 'disable' && n.kind === 'method');
      expect(disableMethod).toBeDefined();
      expect(disableMethod?.qualifiedName).toBe('CachedCounting::disable');

      const incrementMethod = result.nodes.find((n) => n.name === 'perform_increment!' && n.kind === 'method');
      expect(incrementMethod).toBeDefined();
      expect(incrementMethod?.qualifiedName).toBe('CachedCounting::perform_increment!');

      // Containment edge from module to methods
      const containsEdges = result.edges.filter((e) => e.source === moduleNode?.id && e.kind === 'contains');
      expect(containsEdges.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle nested modules with classes', () => {
      const code = `
module Discourse
  module Auth
    class AuthProvider
      def authenticate(params)
        validate(params)
      end
    end
  end
end
`;
      const result = extractFromSource('lib/auth.rb', code);

      const discourseModule = result.nodes.find((n) => n.kind === 'module' && n.name === 'Discourse');
      expect(discourseModule).toBeDefined();

      const authModule = result.nodes.find((n) => n.kind === 'module' && n.name === 'Auth');
      expect(authModule).toBeDefined();
      expect(authModule?.qualifiedName).toBe('Discourse::Auth');

      const authProvider = result.nodes.find((n) => n.kind === 'class' && n.name === 'AuthProvider');
      expect(authProvider).toBeDefined();
      expect(authProvider?.qualifiedName).toBe('Discourse::Auth::AuthProvider');

      const authMethod = result.nodes.find((n) => n.name === 'authenticate');
      expect(authMethod).toBeDefined();
      expect(authMethod?.qualifiedName).toBe('Discourse::Auth::AuthProvider::authenticate');
    });
  });

  describe('C/C++ imports', () => {
    it('should extract system include', () => {
      const code = `#include <iostream>`;
      const result = extractFromSource('main.cpp', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('iostream');
      expect(importNode?.signature).toBe('#include <iostream>');
    });

    it('should extract system include with path', () => {
      const code = `#include <nlohmann/json.hpp>`;
      const result = extractFromSource('app.cpp', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('nlohmann/json.hpp');
    });

    it('should extract local include', () => {
      const code = `#include "myheader.h"`;
      const result = extractFromSource('main.cpp', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('myheader.h');
    });

    it('should extract C header', () => {
      const code = `#include <stdio.h>`;
      const result = extractFromSource('main.c', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('stdio.h');
    });

    it('should extract multiple includes', () => {
      const code = `
#include <iostream>
#include <vector>
#include "config.h"
`;
      const result = extractFromSource('app.cpp', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('iostream');
      expect(names).toContain('vector');
      expect(names).toContain('config.h');
    });

    it('should map CUDA source and header files through C++ extraction', () => {
      const source = `
#include "kernel.cuh"
__global__ void addKernel(float* out) {
  out[0] = 1.0f;
}
`;
      const header = `
#pragma once
void launchAdd(float* out);
`;

      const sourceResult = extractFromSource('src/kernel.cu', source);
      const headerResult = extractFromSource('include/kernel.cuh', header);

      expect(sourceResult.errors).toHaveLength(0);
      expect(headerResult.errors).toHaveLength(0);
      expect(sourceResult.nodes.find((n) => n.kind === 'file')?.language).toBe('cpp');
      expect(headerResult.nodes.find((n) => n.kind === 'file')?.language).toBe('cpp');
      expect(sourceResult.nodes.some((n) => n.kind === 'import' && n.name === 'kernel.cuh')).toBe(true);
    });
  });

  describe('Dart imports', () => {
    it('should extract dart: import', () => {
      const code = `import 'dart:async';`;
      const result = extractFromSource('main.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('dart:async');
      expect(importNode?.signature).toBe("import 'dart:async';");
    });

    it('should extract package import', () => {
      const code = `import 'package:flutter/material.dart';`;
      const result = extractFromSource('app.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('package:flutter/material.dart');
    });

    it('should extract aliased import', () => {
      const code = `import 'package:http/http.dart' as http;`;
      const result = extractFromSource('api.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('package:http/http.dart');
      expect(importNode?.signature).toContain('as http');
    });

    it('should extract multiple imports', () => {
      const code = `
import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
`;
      const result = extractFromSource('main.dart', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('dart:async');
      expect(names).toContain('dart:convert');
      expect(names).toContain('package:flutter/material.dart');
    });

    it('should extract relative import', () => {
      const code = `import '../utils/helpers.dart';`;
      const result = extractFromSource('lib/main.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('../utils/helpers.dart');
    });
  });

  describe('Liquid imports', () => {
    it('should extract render tag', () => {
      const code = `{% render 'loading-spinner' %}`;
      const result = extractFromSource('template.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('loading-spinner');
      expect(importNode?.signature).toContain('render');
    });

    it('should extract section tag', () => {
      const code = `{% section 'header' %}`;
      const result = extractFromSource('layout/theme.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('header');
      expect(importNode?.signature).toContain('section');
    });

    it('should extract include tag', () => {
      const code = `{% include 'icon-cart' %}`;
      const result = extractFromSource('snippets/header.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('icon-cart');
      expect(importNode?.signature).toContain('include');
    });

    it('should extract render with whitespace control', () => {
      const code = `{%- render 'price' -%}`;
      const result = extractFromSource('snippets/product.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('price');
    });

    it('should extract multiple imports', () => {
      const code = `
{% section 'header' %}
{% render 'loading-spinner' %}
{% render 'cart-drawer' %}
`;
      const result = extractFromSource('layout/theme.liquid', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('header');
      expect(names).toContain('loading-spinner');
      expect(names).toContain('cart-drawer');
    });
  });
});

// =============================================================================
// Pascal / Delphi Extraction
// =============================================================================

describe('Pascal / Delphi Extraction', () => {
  describe('Language detection', () => {
    it('should detect Pascal files', () => {
      expect(detectLanguage('UAuth.pas')).toBe('pascal');
      expect(detectLanguage('App.dpr')).toBe('pascal');
      expect(detectLanguage('Package.dpk')).toBe('pascal');
      expect(detectLanguage('App.lpr')).toBe('pascal');
      expect(detectLanguage('MainForm.dfm')).toBe('pascal');
      expect(detectLanguage('MainForm.fmx')).toBe('pascal');
      expect(detectLanguage('MainForm.lfm')).toBe('pascal');
      expect(detectLanguage('Project.lpi')).toBe('pascal');
    });

    it('should report Pascal as supported', () => {
      expect(isLanguageSupported('pascal')).toBe(true);
      expect(getSupportedLanguages()).toContain('pascal');
    });
  });

  describe('Unit extraction', () => {
    it('should extract unit as module', () => {
      const code = `unit MyUnit;\ninterface\nimplementation\nend.`;
      const result = extractFromSource('MyUnit.pas', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.name).toBe('MyUnit');
      expect(moduleNode?.language).toBe('pascal');
    });

    it('should extract program as module', () => {
      const code = `program MyApp;\nbegin\nend.`;
      const result = extractFromSource('MyApp.dpr', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.name).toBe('MyApp');
    });

    it('should extract Lazarus .lpr program source as Pascal', () => {
      const code = `program LazarusApp;\nuses Interfaces, Forms, MainForm;\nbegin\n  Application.Initialize;\n  Application.Run;\nend.`;
      const result = extractFromSource('LazarusApp.lpr', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(result.errors).toHaveLength(0);
      expect(moduleNode?.name).toBe('LazarusApp');
      expect(imports).toContain('Interfaces');
      expect(imports).toContain('Forms');
    });

    it('should fallback to filename when module name is empty', () => {
      // Some .dpr templates use "program;" without a name
      const code = `program;\nuses SysUtils;\nbegin\nend.`;
      const result = extractFromSource('Console.dpr', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.name).toBe('Console');
    });
  });

  describe('Uses clause (imports)', () => {
    it('should extract uses as individual imports', () => {
      const code = `unit Test;\ninterface\nuses\n  System.SysUtils,\n  System.Classes;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const imports = result.nodes.filter((n) => n.kind === 'import');
      expect(imports.length).toBe(2);
      expect(imports.map((n) => n.name)).toContain('System.SysUtils');
      expect(imports.map((n) => n.name)).toContain('System.Classes');
    });

    it('should create unresolved references for imports', () => {
      const code = `unit Test;\ninterface\nuses\n  UAuth;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const importRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'imports'
      );
      expect(importRef).toBeDefined();
      expect(importRef?.referenceName).toBe('UAuth');
    });
  });

  describe('Class extraction', () => {
    it('should extract class declarations', () => {
      const code = `unit Test;\ninterface\ntype\n  TMyClass = class\n  public\n    procedure DoSomething;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('TMyClass');
    });

    it('should extract class with inheritance', () => {
      const code = `unit Test;\ninterface\ntype\n  TChild = class(TParent)\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const extendsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'extends'
      );
      expect(extendsRef).toBeDefined();
      expect(extendsRef?.referenceName).toBe('TParent');
    });

    it('should extract class with interface implementation', () => {
      const code = `unit Test;\ninterface\ntype\n  TService = class(TInterfacedObject, ILogger)\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const extendsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'extends'
      );
      const implementsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'implements'
      );
      expect(extendsRef?.referenceName).toBe('TInterfacedObject');
      expect(implementsRef?.referenceName).toBe('ILogger');
    });
  });

  describe('Record extraction', () => {
    it('should extract records as class nodes', () => {
      const code = `unit Test;\ninterface\ntype\n  TPoint = record\n    X: Double;\n    Y: Double;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('TPoint');

      const fields = result.nodes.filter((n) => n.kind === 'field');
      expect(fields.length).toBe(2);
      expect(fields.map((f) => f.name)).toContain('X');
      expect(fields.map((f) => f.name)).toContain('Y');
    });
  });

  describe('Interface extraction', () => {
    it('should extract interface declarations', () => {
      const code = `unit Test;\ninterface\ntype\n  ILogger = interface\n    procedure Log(const AMsg: string);\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
      expect(ifaceNode).toBeDefined();
      expect(ifaceNode?.name).toBe('ILogger');
    });
  });

  describe('Method extraction', () => {
    it('should extract methods with visibility', () => {
      const code = `unit Test;\ninterface\ntype\n  TMyClass = class\n  private\n    FValue: Integer;\n  public\n    constructor Create;\n    function GetValue: Integer;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const methods = result.nodes.filter((n) => n.kind === 'method');
      expect(methods.length).toBe(2);

      const createMethod = methods.find((m) => m.name === 'Create');
      expect(createMethod?.visibility).toBe('public');

      const getValue = methods.find((m) => m.name === 'GetValue');
      expect(getValue?.visibility).toBe('public');

      const fields = result.nodes.filter((n) => n.kind === 'field');
      const fValue = fields.find((f) => f.name === 'FValue');
      expect(fValue?.visibility).toBe('private');
    });

    it('should detect static methods (class methods)', () => {
      const code = `unit Test;\ninterface\ntype\n  THelper = class\n  public\n    class function Create: THelper; static;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const methods = result.nodes.filter((n) => n.kind === 'method');
      const staticMethod = methods.find((m) => m.name === 'Create');
      expect(staticMethod?.isStatic).toBe(true);
    });
  });

  describe('Enum extraction', () => {
    it('should extract enums with members', () => {
      const code = `unit Test;\ninterface\ntype\n  TColor = (clRed, clGreen, clBlue);\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const enumNode = result.nodes.find((n) => n.kind === 'enum');
      expect(enumNode).toBeDefined();
      expect(enumNode?.name).toBe('TColor');

      const members = result.nodes.filter((n) => n.kind === 'enum_member');
      expect(members.length).toBe(3);
      expect(members.map((m) => m.name)).toEqual(['clRed', 'clGreen', 'clBlue']);
    });
  });

  describe('Property extraction', () => {
    it('should extract properties', () => {
      const code = `unit Test;\ninterface\ntype\n  TObj = class\n  public\n    property Name: string read FName write FName;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const propNode = result.nodes.find((n) => n.kind === 'property');
      expect(propNode).toBeDefined();
      expect(propNode?.name).toBe('Name');
      expect(propNode?.visibility).toBe('public');
    });
  });

  describe('Constant extraction', () => {
    it('should extract constants', () => {
      const code = `unit Test;\ninterface\nconst\n  MAX_RETRIES = 3;\n  APP_NAME = 'MyApp';\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const constants = result.nodes.filter((n) => n.kind === 'constant');
      expect(constants.length).toBe(2);
      expect(constants.map((c) => c.name)).toContain('MAX_RETRIES');
      expect(constants.map((c) => c.name)).toContain('APP_NAME');
    });
  });

  describe('Type alias extraction', () => {
    it('should extract type aliases', () => {
      const code = `unit Test;\ninterface\ntype\n  TUserName = string;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const aliasNode = result.nodes.find((n) => n.kind === 'type_alias');
      expect(aliasNode).toBeDefined();
      expect(aliasNode?.name).toBe('TUserName');
    });
  });

  describe('Call extraction', () => {
    it('should extract calls from implementation bodies', () => {
      const code = `unit Test;\ninterface\ntype\n  TObj = class\n  public\n    procedure DoWork;\n  end;\nimplementation\nprocedure TObj.DoWork;\nbegin\n  WriteLn('hello');\nend;\nend.`;
      const result = extractFromSource('Test.pas', code);

      const callRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'calls'
      );
      expect(callRef).toBeDefined();
      expect(callRef?.referenceName).toBe('WriteLn');
    });
  });

  describe('Containment edges', () => {
    it('should create contains edges for class members', () => {
      const code = `unit Test;\ninterface\ntype\n  TObj = class\n  public\n    procedure Foo;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      const methodNode = result.nodes.find((n) => n.kind === 'method');
      expect(classNode).toBeDefined();
      expect(methodNode).toBeDefined();

      const containsEdge = result.edges.find(
        (e) => e.source === classNode?.id && e.target === methodNode?.id && e.kind === 'contains'
      );
      expect(containsEdge).toBeDefined();
    });
  });

  describe('Full fixture: UAuth.pas', () => {
    const code = `unit UAuth;

interface

uses
  System.SysUtils,
  System.Classes;

type
  ITokenValidator = interface
    ['{11111111-1111-1111-1111-111111111111}']
    function Validate(const AToken: string): Boolean;
  end;

  TAuthService = class(TInterfacedObject, ITokenValidator)
  private
    FToken: string;
    FLoginCount: Integer;
    procedure IncLoginCount;
  protected
    function GetToken: string;
  public
    constructor Create;
    destructor Destroy; override;
    function Validate(const AToken: string): Boolean;
    function Login(const AUser, APass: string): string;
    property Token: string read GetToken;
    property LoginCount: Integer read FLoginCount;
  end;

implementation

constructor TAuthService.Create;
begin
  inherited Create;
  FToken := '';
  FLoginCount := 0;
end;

destructor TAuthService.Destroy;
begin
  FToken := '';
  inherited Destroy;
end;

procedure TAuthService.IncLoginCount;
begin
  Inc(FLoginCount);
end;

function TAuthService.GetToken: string;
begin
  Result := FToken;
end;

function TAuthService.Validate(const AToken: string): Boolean;
begin
  Result := AToken <> '';
end;

function TAuthService.Login(const AUser, APass: string): string;
begin
  IncLoginCount;
  if Validate(AUser + ':' + APass) then
  begin
    FToken := AUser;
    Result := 'ok';
  end
  else
    Result := '';
end;

end.`;

    it('should extract all expected nodes', () => {
      const result = extractFromSource('UAuth.pas', code);

      expect(result.errors).toHaveLength(0);

      // Module
      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode?.name).toBe('UAuth');

      // Imports
      const imports = result.nodes.filter((n) => n.kind === 'import');
      expect(imports.length).toBe(2);

      // Interface
      const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
      expect(ifaceNode?.name).toBe('ITokenValidator');

      // Class
      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode?.name).toBe('TAuthService');

      // Methods
      const methods = result.nodes.filter((n) => n.kind === 'method');
      expect(methods.length).toBeGreaterThanOrEqual(6);
      expect(methods.map((m) => m.name)).toContain('Create');
      expect(methods.map((m) => m.name)).toContain('Destroy');
      expect(methods.map((m) => m.name)).toContain('Login');

      // Fields
      const fields = result.nodes.filter((n) => n.kind === 'field');
      expect(fields.length).toBe(2);
      expect(fields.every((f) => f.visibility === 'private')).toBe(true);

      // Properties
      const props = result.nodes.filter((n) => n.kind === 'property');
      expect(props.length).toBe(2);
      expect(props.map((p) => p.name)).toContain('Token');
      expect(props.map((p) => p.name)).toContain('LoginCount');
    });

    it('should extract inheritance and interface implementation', () => {
      const result = extractFromSource('UAuth.pas', code);

      const extendsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'extends'
      );
      expect(extendsRef?.referenceName).toBe('TInterfacedObject');

      const implementsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'implements'
      );
      expect(implementsRef?.referenceName).toBe('ITokenValidator');
    });

    it('should extract calls from implementation', () => {
      const result = extractFromSource('UAuth.pas', code);

      const callRefs = result.unresolvedReferences.filter(
        (r) => r.referenceKind === 'calls'
      );
      expect(callRefs.map((r) => r.referenceName)).toContain('Inc');
      expect(callRefs.map((r) => r.referenceName)).toContain('Validate');
    });
  });

  describe('Full fixture: UTypes.pas', () => {
    const code = `unit UTypes;

interface

uses
  System.SysUtils;

const
  C_MAX_RETRIES = 3;
  C_DEFAULT_NAME = 'Guest';

type
  TUserRole = (urAdmin, urEditor, urViewer);

  TPoint2D = record
    X: Double;
    Y: Double;
  end;

  TUserName = string;

  TUserInfo = class
  public
    type
      TAddress = record
        Street: string;
        City: string;
        Zip: string;
      end;
  private
    FName: TUserName;
    FRole: TUserRole;
    FAddress: TAddress;
  public
    constructor Create(const AName: TUserName; ARole: TUserRole);
    function GetDisplayName: string;
    class function CreateAdmin(const AName: TUserName): TUserInfo; static;
    property Name: TUserName read FName write FName;
    property Role: TUserRole read FRole;
    property Address: TAddress read FAddress write FAddress;
  end;

implementation

constructor TUserInfo.Create(const AName: TUserName; ARole: TUserRole);
begin
  FName := AName;
  FRole := ARole;
end;

function TUserInfo.GetDisplayName: string;
begin
  if FRole = urAdmin then
    Result := '[Admin] ' + FName
  else
    Result := FName;
end;

class function TUserInfo.CreateAdmin(const AName: TUserName): TUserInfo;
begin
  Result := TUserInfo.Create(AName, urAdmin);
end;

end.`;

    it('should extract enums with members', () => {
      const result = extractFromSource('UTypes.pas', code);

      const enumNode = result.nodes.find((n) => n.kind === 'enum');
      expect(enumNode?.name).toBe('TUserRole');

      const members = result.nodes.filter((n) => n.kind === 'enum_member');
      expect(members.length).toBe(3);
      expect(members.map((m) => m.name)).toEqual(['urAdmin', 'urEditor', 'urViewer']);
    });

    it('should extract constants', () => {
      const result = extractFromSource('UTypes.pas', code);

      const constants = result.nodes.filter((n) => n.kind === 'constant');
      expect(constants.length).toBe(2);
      expect(constants.map((c) => c.name)).toContain('C_MAX_RETRIES');
      expect(constants.map((c) => c.name)).toContain('C_DEFAULT_NAME');
    });

    it('should extract type aliases', () => {
      const result = extractFromSource('UTypes.pas', code);

      const aliases = result.nodes.filter((n) => n.kind === 'type_alias');
      expect(aliases.map((a) => a.name)).toContain('TUserName');
    });

    it('should extract records as classes with fields', () => {
      const result = extractFromSource('UTypes.pas', code);

      const classes = result.nodes.filter((n) => n.kind === 'class');
      expect(classes.map((c) => c.name)).toContain('TPoint2D');

      // TPoint2D fields
      const fields = result.nodes.filter((n) => n.kind === 'field');
      expect(fields.map((f) => f.name)).toContain('X');
      expect(fields.map((f) => f.name)).toContain('Y');
    });

    it('should extract static class methods', () => {
      const result = extractFromSource('UTypes.pas', code);

      const methods = result.nodes.filter((n) => n.kind === 'method');
      const staticMethod = methods.find((m) => m.name === 'CreateAdmin');
      expect(staticMethod).toBeDefined();
      expect(staticMethod?.isStatic).toBe(true);
    });

    it('should extract nested types', () => {
      const result = extractFromSource('UTypes.pas', code);

      const classes = result.nodes.filter((n) => n.kind === 'class');
      expect(classes.map((c) => c.name)).toContain('TAddress');
    });
  });
});

// =============================================================================
// DFM/FMX Extraction
// =============================================================================

describe('DFM/FMX Extraction', () => {
  it('should extract components from DFM', () => {
    const code = `object Form1: TForm1
  Left = 0
  Top = 0
  Caption = 'My Form'
  object Button1: TButton
    Left = 10
    Top = 10
    Caption = 'Click Me'
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);
    expect(components.map((c) => c.name)).toContain('Form1');
    expect(components.map((c) => c.name)).toContain('Button1');

    const button = components.find((c) => c.name === 'Button1');
    expect(button?.signature).toBe('TButton');
  });

  it('should extract components from Lazarus LFM forms', () => {
    const code = `object MainForm: TMainForm
  Caption = 'Lazarus Form'
  object RunButton: TButton
    OnClick = RunButtonClick
  end
end`;
    const result = extractFromSource('MainForm.lfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(result.errors).toHaveLength(0);
    expect(components.map((c) => c.name)).toContain('MainForm');
    expect(components.map((c) => c.name)).toContain('RunButton');
    expect(result.unresolvedReferences.map((r) => r.referenceName)).toContain('RunButtonClick');
  });

  it('should track Lazarus LPI project files without semantic extraction', () => {
    const code = `<?xml version="1.0" encoding="UTF-8"?>
<CONFIG>
  <ProjectOptions>
    <Title Value="LazarusApp"/>
  </ProjectOptions>
</CONFIG>`;
    const result = extractFromSource('LazarusApp.lpi', code);

    expect(result.errors).toHaveLength(0);
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('should extract nested component hierarchy', () => {
    const code = `object Form1: TForm1
  object Panel1: TPanel
    object Label1: TLabel
      Caption = 'Hello'
    end
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(3);

    // Check nesting: Panel1 contains Label1
    const panel = components.find((c) => c.name === 'Panel1');
    const label = components.find((c) => c.name === 'Label1');
    const containsEdge = result.edges.find(
      (e) => e.source === panel?.id && e.target === label?.id && e.kind === 'contains'
    );
    expect(containsEdge).toBeDefined();
  });

  it('should extract event handler references', () => {
    const code = `object Form1: TForm1
  OnCreate = FormCreate
  OnDestroy = FormDestroy
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const refs = result.unresolvedReferences;
    expect(refs.length).toBe(3);
    expect(refs.map((r) => r.referenceName)).toContain('FormCreate');
    expect(refs.map((r) => r.referenceName)).toContain('FormDestroy');
    expect(refs.map((r) => r.referenceName)).toContain('Button1Click');
    expect(refs.every((r) => r.referenceKind === 'references')).toBe(true);
  });

  it('should handle multi-line properties', () => {
    const code = `object Form1: TForm1
  SQL.Strings = (
    'SELECT * FROM users'
    'WHERE active = 1')
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);

    const refs = result.unresolvedReferences;
    expect(refs.length).toBe(1);
    expect(refs[0]?.referenceName).toBe('Button1Click');
  });

  it('should handle inherited keyword', () => {
    const code = `inherited Form1: TForm1
  Caption = 'Inherited Form'
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);
    expect(components.map((c) => c.name)).toContain('Form1');
  });

  it('should handle item collection properties', () => {
    const code = `object Form1: TForm1
  object StatusBar1: TStatusBar
    Panels = <
      item
        Width = 200
      end
      item
        Width = 200
      end>
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);
  });

  describe('Full fixture: MainForm.dfm', () => {
    const code = `object frmMain: TfrmMain
  Left = 0
  Top = 0
  Caption = 'SolidKG DFM Fixture'
  ClientHeight = 480
  ClientWidth = 640
  OnCreate = FormCreate
  OnDestroy = FormDestroy
  object pnlTop: TPanel
    Left = 0
    Top = 0
    Width = 640
    Height = 50
    object lblTitle: TLabel
      Left = 16
      Top = 16
      Caption = 'Authentication Service'
    end
    object btnLogin: TButton
      Left = 540
      Top = 12
      OnClick = btnLoginClick
    end
  end
  object pnlContent: TPanel
    Left = 0
    Top = 50
    object edtUsername: TEdit
      Left = 16
      Top = 16
      OnChange = edtUsernameChange
    end
    object edtPassword: TEdit
      Left = 16
      Top = 48
      OnKeyPress = edtPasswordKeyPress
    end
    object mmoLog: TMemo
      Left = 16
      Top = 88
    end
  end
  object pnlStatus: TStatusBar
    Left = 0
    Top = 440
    Panels = <
      item
        Width = 200
      end
      item
        Width = 200
      end>
  end
end`;

    it('should extract all components', () => {
      const result = extractFromSource('MainForm.dfm', code);

      const components = result.nodes.filter((n) => n.kind === 'component');
      expect(components.length).toBe(9);
      expect(components.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          'frmMain', 'pnlTop', 'lblTitle', 'btnLogin',
          'pnlContent', 'edtUsername', 'edtPassword', 'mmoLog', 'pnlStatus',
        ])
      );
    });

    it('should extract all event handlers', () => {
      const result = extractFromSource('MainForm.dfm', code);

      const refs = result.unresolvedReferences;
      expect(refs.length).toBe(5);
      expect(refs.map((r) => r.referenceName)).toEqual(
        expect.arrayContaining([
          'FormCreate', 'FormDestroy', 'btnLoginClick',
          'edtUsernameChange', 'edtPasswordKeyPress',
        ])
      );
    });
  });
});

describe('Full Indexing', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should search TypeScript private class fields with and without the hash prefix', async () => {
    const srcDir = path.join(tempDir, 'source', 'core');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'Ky.ts'),
      `
class Ky {
  readonly #startTime: number | undefined;

  public getRemainingTotalTimeout = (): number | undefined => {
    return this.#startTime;
  };
}
`
    );

    const cg = SolidKG.initSync(tempDir);
    try {
      const result = await cg.indexAll();

      expect(result.success).toBe(true);
      const hashMatches = cg.searchNodes('#startTime', { kinds: ['field'], limit: 5 });
      const bareMatches = cg.searchNodes('startTime', { kinds: ['field'], limit: 5 });

      const byHash = hashMatches.find((entry) => entry.node.name === '#startTime');
      const byBare = bareMatches.find((entry) => entry.node.name === '#startTime');
      expect(byHash?.node.kind).toBe('field');
      expect(byHash?.node.filePath).toBe('source/core/Ky.ts');
      expect(byHash?.node.startLine).toBe(3);
      expect(byBare?.node.kind).toBe('field');

      const arrowMethod = cg.searchNodes('getRemainingTotalTimeout', { limit: 5 })
        .find((entry) => entry.node.name === 'getRemainingTotalTimeout');
      expect(arrowMethod?.node.kind).toBe('method');
    } finally {
      cg.close();
    }
  });

  it('should index a TypeScript file', async () => {
    // Create test file
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'utils.ts'),
      `
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`
    );

    // Initialize and index
    const cg = SolidKG.initSync(tempDir);
    const result = await cg.indexAll();

    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(1);
    expect(result.nodesCreated).toBeGreaterThanOrEqual(2);

    // Check nodes were stored
    const nodes = cg.getNodesInFile('src/utils.ts');
    expect(nodes.length).toBeGreaterThanOrEqual(2);

    const addFunc = nodes.find((n) => n.name === 'add');
    expect(addFunc).toBeDefined();
    expect(addFunc?.kind).toBe('function');

    cg.close();
  });

  it('should index multiple files', async () => {
    // Create test files
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'math.ts'),
      `export function add(a: number, b: number) { return a + b; }`
    );

    fs.writeFileSync(
      path.join(srcDir, 'string.ts'),
      `export function capitalize(s: string) { return s.toUpperCase(); }`
    );

    // Initialize and index
    const cg = SolidKG.initSync(tempDir);
    const result = await cg.indexAll();

    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(2);

    const files = cg.getFiles();
    expect(files.length).toBe(2);

    cg.close();
  });

  it('reconciles deleted files during default full indexing', async () => {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'keep.ts'), `export function keepMe() { return 1; }`);
    fs.writeFileSync(path.join(srcDir, 'remove.ts'), `export function removeMe() { return 2; }`);

    const cg = SolidKG.initSync(tempDir);
    await cg.indexAll();
    expect(cg.searchNodes('removeMe').length).toBeGreaterThan(0);

    fs.unlinkSync(path.join(srcDir, 'remove.ts'));
    const result = await cg.indexAll();

    expect(result.success).toBe(true);
    expect(cg.searchNodes('keepMe').length).toBeGreaterThan(0);
    expect(cg.searchNodes('removeMe')).toHaveLength(0);
    expect(cg.getFile('src/remove.ts')).toBeNull();
    cg.close();
  });

  it('reconciles files that become excluded or oversized during default full indexing', async () => {
    fs.writeFileSync(path.join(tempDir, 'visible.ts'), `export function visibleFn() { return 1; }`);
    fs.writeFileSync(path.join(tempDir, 'ignored.ts'), `export function ignoredFn() { return 2; }`);
    fs.writeFileSync(path.join(tempDir, 'large.ts'), `export function largeFn() { return 3; }\n${'x'.repeat(200)}`);

    const cg = SolidKG.initSync(tempDir);
    await cg.indexAll();
    expect(cg.searchNodes('ignoredFn').length).toBeGreaterThan(0);
    expect(cg.searchNodes('largeFn').length).toBeGreaterThan(0);

    const result = await cg.indexAll({ excludePatterns: ['ignored.ts'], maxFileSizeBytes: 100 });

    expect(result.success).toBe(true);
    expect(cg.searchNodes('visibleFn').length).toBeGreaterThan(0);
    expect(cg.searchNodes('ignoredFn')).toHaveLength(0);
    expect(cg.searchNodes('largeFn')).toHaveLength(0);
    expect(cg.getFile('ignored.ts')).toBeNull();
    expect(cg.getFile('large.ts')).toBeNull();
    cg.close();
  });

  it('indexes first-party source up to the default max file size', async () => {
    const size = Math.min(DEFAULT_MAX_FILE_SIZE_BYTES - 1024, 2 * 1024 * 1024);
    fs.writeFileSync(
      path.join(tempDir, 'large-but-valid.ts'),
      `export function largeButValid() { return 1; }\n/*${'x'.repeat(size)}*/\n`
    );

    const cg = SolidKG.initSync(tempDir);
    const result = await cg.indexAll();

    expect(result.success).toBe(true);
    expect(result.filesSkipped).toBe(0);
    expect(result.skippedFiles ?? []).not.toContainEqual(expect.objectContaining({ reason: 'max_size' }));
    expect(cg.searchNodes('largeButValid').length).toBeGreaterThan(0);
    cg.close();
  });

  it('should discover and parse explicit Node module extensions', async () => {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'esm.mts'), 'export function esmTs() { return 1; }');
    fs.writeFileSync(path.join(srcDir, 'common.cts'), 'export function commonTs() { return 2; }');
    fs.writeFileSync(path.join(srcDir, 'esm-js.mjs'), 'export function esmJs() { return 3; }');
    fs.writeFileSync(path.join(srcDir, 'common-js.cjs'), 'exports.commonJs = function commonJs() { return 4; };');

    const files = scanDirectory(tempDir);
    const cg = SolidKG.initSync(tempDir);
    const result = await cg.indexAll();
    const indexedFiles = cg.getFiles().map((file) => file.path);
    const allNodes = [
      ...cg.getNodesInFile('src/esm.mts'),
      ...cg.getNodesInFile('src/common.cts'),
      ...cg.getNodesInFile('src/esm-js.mjs'),
      ...cg.getNodesInFile('src/common-js.cjs'),
    ];

    expect(files).toEqual(expect.arrayContaining([
      'src/esm.mts',
      'src/common.cts',
      'src/esm-js.mjs',
      'src/common-js.cjs',
    ]));
    expect(result.success).toBe(true);
    expect(indexedFiles).toEqual(expect.arrayContaining(files));
    expect(allNodes.some((n) => n.name === 'esmTs')).toBe(true);
    expect(allNodes.some((n) => n.name === 'commonTs')).toBe(true);
    expect(allNodes.some((n) => n.name === 'esmJs')).toBe(true);

    cg.close();
  });

  it('should discover CUDA and Lazarus file extensions conservatively', async () => {
    fs.mkdirSync(path.join(tempDir, 'gpu'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'lazarus'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'gpu', 'kernel.cu'), '#include "kernel.cuh"\n__global__ void addKernel(float* out) { out[0] = 1.0f; }\n');
    fs.writeFileSync(path.join(tempDir, 'gpu', 'kernel.cuh'), '#pragma once\nvoid launchAdd(float* out);\n');
    fs.writeFileSync(path.join(tempDir, 'lazarus', 'App.lpr'), 'program App;\nbegin\nend.\n');
    fs.writeFileSync(path.join(tempDir, 'lazarus', 'MainForm.lfm'), 'object MainForm: TMainForm\nend\n');
    fs.writeFileSync(path.join(tempDir, 'lazarus', 'App.lpi'), '<CONFIG><ProjectOptions/></CONFIG>\n');

    const files = scanDirectory(tempDir);
    const cg = SolidKG.initSync(tempDir);
    const result = await cg.indexAll();
    const indexedFiles = cg.getFiles().map((file) => file.path);

    expect(files).toEqual(expect.arrayContaining([
      'gpu/kernel.cu',
      'gpu/kernel.cuh',
      'lazarus/App.lpr',
      'lazarus/MainForm.lfm',
      'lazarus/App.lpi',
    ]));
    expect(result.success).toBe(true);
    expect(indexedFiles).toEqual(expect.arrayContaining(files));
    expect(cg.getFile('lazarus/App.lpi')?.nodeCount).toBe(0);
    expect(cg.getNodesInFile('lazarus/MainForm.lfm').some((n) => n.kind === 'component' && n.name === 'MainForm')).toBe(true);

    cg.close();
  });

  it('should count YAML file-level records as indexed, not skipped', async () => {
    fs.writeFileSync(path.join(tempDir, 'config.yaml'), 'name: app\n');

    const cg = SolidKG.initSync(tempDir);
    const result = await cg.indexAll();
    const file = cg.getFile('config.yaml');

    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(1);
    expect(result.filesSkipped).toBe(0);
    expect(file?.language).toBe('yaml');
    expect(file?.nodeCount).toBe(0);

    cg.close();
  });

  it('should track file hashes for incremental updates', async () => {
    // Create initial file
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'main.ts'), `export const x = 1;`);

    // Initialize and index
    const cg = SolidKG.initSync(tempDir);
    await cg.indexAll();

    // Check file is tracked
    const file = cg.getFile('src/main.ts');
    expect(file).toBeDefined();
    expect(file?.contentHash).toBeDefined();

    // Modify file
    fs.writeFileSync(path.join(srcDir, 'main.ts'), `export const x = 2;`);

    // Check for changes
    const changes = cg.getChangedFiles();
    expect(changes.modified).toContain('src/main.ts');

    cg.close();
  });

  it('should sync and detect changes', async () => {
    // Create initial file
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'main.ts'),
      `export function original() { return 1; }`
    );

    // Initialize and index
    const cg = SolidKG.initSync(tempDir);
    await cg.indexAll();

    const initialNodes = cg.getNodesInFile('src/main.ts');
    expect(initialNodes.some((n) => n.name === 'original')).toBe(true);

    // Modify file
    fs.writeFileSync(
      path.join(srcDir, 'main.ts'),
      `export function updated() { return 2; }`
    );

    // Sync
    const syncResult = await cg.sync();
    expect(syncResult.filesModified).toBe(1);

    // Check nodes were updated
    const updatedNodes = cg.getNodesInFile('src/main.ts');
    expect(updatedNodes.some((n) => n.name === 'updated')).toBe(true);
    expect(updatedNodes.some((n) => n.name === 'original')).toBe(false);

    cg.close();
  });
});

describe('Path Normalization', () => {
  it('should convert backslashes to forward slashes', () => {
    expect(normalizePath('gui\\node_modules\\foo')).toBe('gui/node_modules/foo');
    expect(normalizePath('src\\components\\Button.tsx')).toBe('src/components/Button.tsx');
  });

  it('should leave forward-slash paths unchanged', () => {
    expect(normalizePath('src/components/Button.tsx')).toBe('src/components/Button.tsx');
  });

  it('should handle empty string', () => {
    expect(normalizePath('')).toBe('');
  });
});

describe('Directory Exclusion', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should exclude directories listed in .gitignore', () => {
    // Create structure: src/index.ts + node_modules/pkg/index.js, gitignore node_modules
    const srcDir = path.join(tempDir, 'src');
    const nmDir = path.join(tempDir, 'node_modules', 'pkg');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/\n');

    const files = scanDirectory(tempDir);

    expect(files).toContain('src/index.ts');
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
  });

  it('should exclude nested node_modules via a root .gitignore', () => {
    // A trailing-slash pattern with no leading slash matches at any depth.
    const srcDir = path.join(tempDir, 'packages', 'app', 'src');
    const nmDir = path.join(tempDir, 'packages', 'app', 'node_modules', 'pkg');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/\n');

    const files = scanDirectory(tempDir);

    expect(files).toContain('packages/app/src/index.ts');
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
  });

  it('should apply a nested .gitignore only to its own subtree', () => {
    const appSrc = path.join(tempDir, 'app', 'src');
    fs.mkdirSync(appSrc, { recursive: true });
    fs.writeFileSync(path.join(appSrc, 'keep.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(appSrc, 'skip.ts'), 'export const b = 2;');
    fs.writeFileSync(path.join(tempDir, 'app', '.gitignore'), 'src/skip.ts\n');
    // A sibling with the same name outside app/ must NOT be ignored.
    const otherDir = path.join(tempDir, 'other', 'src');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'skip.ts'), 'export const c = 3;');

    const files = scanDirectory(tempDir);

    expect(files).toContain('app/src/keep.ts');
    expect(files).not.toContain('app/src/skip.ts');
    expect(files).toContain('other/src/skip.ts');
  });

  it('should always skip .git directories', () => {
    const srcDir = path.join(tempDir, 'src');
    const gitDir = path.join(tempDir, '.git', 'objects');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(gitDir, 'pack.ts'), 'export const y = 2;');

    const files = scanDirectory(tempDir);

    expect(files).toContain('src/index.ts');
    expect(files.every((f) => !f.includes('.git'))).toBe(true);
  });


  it.runIf(process.platform === 'win32')('scans a large NTFS source tree within a bounded window', async () => {
    const largeRoot = path.join(tempDir, 'large-ntfs-root');
    const packageCount = 60;
    const filesPerPackage = 35;
    for (let pkg = 0; pkg < packageCount; pkg++) {
      const dir = path.join(largeRoot, 'packages', `pkg-${pkg}`, 'src');
      fs.mkdirSync(dir, { recursive: true });
      for (let file = 0; file < filesPerPackage; file++) {
        fs.writeFileSync(path.join(dir, `file-${file}.ts`), `export const value${pkg}_${file} = ${file};\n`);
      }
    }

    const started = Date.now();
    const files = await Promise.race([
      scanDirectoryAsync(largeRoot),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('scanDirectoryAsync timed out after 10s')), 10000)),
    ]);

    expect(files).toHaveLength(packageCount * filesPerPackage);
    expect(Date.now() - started).toBeLessThan(10000);
  }, 15000);

  it('should return forward-slash paths on all platforms', () => {
    const srcDir = path.join(tempDir, 'src', 'components');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'Button.tsx'), 'export function Button() {}');

    const files = scanDirectory(tempDir);

    expect(files.length).toBe(1);
    expect(files[0]).toBe('src/components/Button.tsx');
    expect(files[0]).not.toContain('\\');
  });

  it('should skip committed vendor and vendored source by default and include it with opt-in', async () => {
    const { execFileSync } = await import('child_process');
    const repo = path.join(tempDir, 'vendored-source');
    fs.mkdirSync(path.join(repo, 'cmd', 'app'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'vendor', 'example.com', 'dep'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'vendored', 'example.com', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'go.mod'), 'module example.com/app\n\ngo 1.22\n');
    fs.writeFileSync(path.join(repo, 'cmd', 'app', 'main.go'), 'package main\n\nfunc AppSource() {}\n');
    fs.writeFileSync(path.join(repo, 'vendor', 'example.com', 'dep', 'dep.go'), 'package dep\n\nfunc VendorSource() {}\n');
    fs.writeFileSync(path.join(repo, 'vendored', 'example.com', 'dep', 'dep.go'), 'package dep\n\nfunc VendoredSource() {}\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'vendor/\nvendored/\n');
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['add', '-f', 'vendor/example.com/dep/dep.go'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['add', '-f', 'vendored/example.com/dep/dep.go'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['add', 'go.mod', 'cmd/app/main.go', '.gitignore'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'pipe' });

    const defaultGraph = await SolidKG.init(repo);
    const defaultResult = await defaultGraph.indexAll();
    const defaultFiles = defaultGraph.getFiles().map((file) => file.path);
    defaultGraph.destroy();

    fs.rmSync(path.join(repo, '.solidkg'), { recursive: true, force: true });
    const optInGraph = await SolidKG.init(repo, { includeVendored: true });
    const optInResult = await optInGraph.indexAll({ includeVendored: true });
    const optInFiles = optInGraph.getFiles().map((file) => file.path);
    optInGraph.destroy();

    expect(defaultFiles).toContain('cmd/app/main.go');
    expect(defaultFiles).not.toContain('vendor/example.com/dep/dep.go');
    expect(defaultFiles).not.toContain('vendored/example.com/dep/dep.go');
    expect(defaultResult.skippedFiles?.some((file) => file.path === 'vendor/example.com/dep/dep.go' && file.reason === 'excluded')).toBe(true);
    expect(defaultResult.skippedFiles?.some((file) => file.path === 'vendored/example.com/dep/dep.go' && file.reason === 'excluded')).toBe(true);
    expect(optInFiles).toContain('cmd/app/main.go');
    expect(optInFiles).toContain('vendor/example.com/dep/dep.go');
    expect(optInFiles).toContain('vendored/example.com/dep/dep.go');
    expect(optInResult.skippedFiles?.some((file) => file.path === 'vendor/example.com/dep/dep.go')).toBe(false);
    expect(optInResult.skippedFiles?.some((file) => file.path === 'vendored/example.com/dep/dep.go')).toBe(false);
  });

  it('should skip files over the configured max size and report them', async () => {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'small.ts'), 'export const small = 1;\n');
    fs.writeFileSync(path.join(srcDir, 'large.ts'), `export const large = "${'x'.repeat(200)}";\n`);

    const graph = await SolidKG.init(tempDir, { maxFileSizeBytes: 80 });
    const issues: string[] = [];
    const result = await graph.indexAll({
      maxFileSizeBytes: 80,
      onIssue: (issue) => {
        issues.push(issue.kind === 'diagnostic' ? `${issue.diagnostic.severity}:${issue.diagnostic.code}:${issue.diagnostic.filePath}` : `skipped:${issue.skipped.reason}:${issue.skipped.path}`);
      },
    });
    const files = graph.getFiles().map((file) => file.path);
    graph.destroy();

    expect(files).toContain('src/small.ts');
    expect(files).not.toContain('src/large.ts');
    expect(result.filesSkipped).toBeGreaterThanOrEqual(1);
    expect(result.skippedFiles).toContainEqual(expect.objectContaining({ path: 'src/large.ts', reason: 'max_size', limit: 80 }));
    expect(result.errors).toContainEqual(expect.objectContaining({ filePath: 'src/large.ts', severity: 'warning', code: 'size_exceeded' }));
    expect(issues).toContain('warning:size_exceeded:src/large.ts');
    expect(issues).toContain('skipped:max_size:src/large.ts');
  });

  it('does not fail indexing when the live issue sink throws', async () => {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'small.ts'), 'export const small = 1;\n');
    fs.writeFileSync(path.join(srcDir, 'large.ts'), `export const large = "${'x'.repeat(200)}";\n`);

    const graph = await SolidKG.init(tempDir, { maxFileSizeBytes: 80 });
    const result = await graph.indexAll({
      maxFileSizeBytes: 80,
      onIssue: () => {
        throw new Error('log target unavailable');
      },
    });
    graph.destroy();

    expect(result.success).toBe(true);
    expect(result.skippedFiles).toContainEqual(expect.objectContaining({ path: 'src/large.ts', reason: 'max_size' }));
  });
});

describe('Git Submodules', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should skip git submodules by default and include them with opt-in', async () => {
    const { execFileSync } = await import('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });

    // Build a separate "library" repo to use as a submodule source.
    const libDir = path.join(tempDir, '_lib');
    fs.mkdirSync(libDir, { recursive: true });
    git(libDir, 'init', '-q');
    git(libDir, 'config', 'user.email', 'test@test.com');
    git(libDir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(libDir, 'lib.ts'), 'export const fromSubmodule = 1;');
    git(libDir, 'add', '-A');
    git(libDir, 'commit', '-q', '-m', 'lib init');

    // Build the main repo and add the lib repo as a submodule.
    const mainDir = path.join(tempDir, 'main');
    fs.mkdirSync(mainDir, { recursive: true });
    git(mainDir, 'init', '-q');
    git(mainDir, 'config', 'user.email', 'test@test.com');
    git(mainDir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(mainDir, 'app.ts'), 'export const app = 1;');
    git(mainDir, 'add', '-A');
    git(mainDir, 'commit', '-q', '-m', 'app init');
    // protocol.file.allow=always is required to add a local-path submodule on
    // recent git versions (CVE-2022-39253 mitigation).
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', libDir, 'libs/lib'],
      { cwd: mainDir, stdio: 'pipe' }
    );
    git(mainDir, 'commit', '-q', '-m', 'add submodule');

    const defaultFiles = scanDirectory(mainDir);
    const optInFiles = scanDirectory(mainDir, undefined, { includeSubmodules: true });

    expect(defaultFiles).toContain('app.ts');
    expect(defaultFiles).not.toContain('libs/lib/lib.ts');
    expect(optInFiles).toContain('app.ts');
    expect(optInFiles).toContain('libs/lib/lib.ts');
  });

  it('should not index a submodule directory whose path has a source extension', async () => {
    const { execFileSync } = await import('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });

    const libDir = path.join(tempDir, '_whisper');
    fs.mkdirSync(libDir, { recursive: true });
    git(libDir, 'init', '-q');
    git(libDir, 'config', 'user.email', 'test@test.com');
    git(libDir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(libDir, 'main.cpp'), 'int whisper() { return 1; }\n');
    git(libDir, 'add', '-A');
    git(libDir, 'commit', '-q', '-m', 'lib init');

    const mainDir = path.join(tempDir, 'main');
    fs.mkdirSync(mainDir, { recursive: true });
    git(mainDir, 'init', '-q');
    git(mainDir, 'config', 'user.email', 'test@test.com');
    git(mainDir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(mainDir, 'app.ts'), 'export const app = 1;');
    git(mainDir, 'add', '-A');
    git(mainDir, 'commit', '-q', '-m', 'app init');
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', libDir, 'backend/whisper.cpp'],
      { cwd: mainDir, stdio: 'pipe' }
    );
    git(mainDir, 'commit', '-q', '-m', 'add whisper submodule');

    const files = scanDirectory(mainDir);
    const graph = await SolidKG.init(mainDir);
    const result = await graph.indexAll();
    graph.destroy();

    expect(files).toContain('app.ts');
    expect(files).not.toContain('backend/whisper.cpp');
    expect(result.filesErrored).toBe(0);
    expect(result.errors).not.toContainEqual(expect.objectContaining({ filePath: 'backend/whisper.cpp', code: 'read_error' }));
  });
});

describe('Nested non-submodule git repos', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should index files in embedded git repos run from a git super-repo (issue #193)', async () => {
    const { execFileSync } = await import('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });

    // Top-level workspace is itself a git repo, holding no source directly —
    // the CMake "super-repo" layout from the issue.
    const root = path.join(tempDir, 'root');
    fs.mkdirSync(path.join(root, 'coding'), { recursive: true });
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@test.com');
    git(root, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\n');

    // Two independent clones living inside the workspace (NOT submodules):
    // one with committed source, one with only untracked source.
    const sub1 = path.join(root, 'sub_repo1', 'src');
    fs.mkdirSync(sub1, { recursive: true });
    git(path.join(root, 'sub_repo1'), 'init', '-q');
    git(path.join(root, 'sub_repo1'), 'config', 'user.email', 'test@test.com');
    git(path.join(root, 'sub_repo1'), 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(sub1, 'one.ts'), 'export const one = 1;');
    git(path.join(root, 'sub_repo1'), 'add', '-A');
    git(path.join(root, 'sub_repo1'), 'commit', '-q', '-m', 'sub1 init');

    const sub2 = path.join(root, 'sub_repo2', 'src');
    fs.mkdirSync(sub2, { recursive: true });
    git(path.join(root, 'sub_repo2'), 'init', '-q');
    fs.writeFileSync(path.join(sub2, 'two.ts'), 'export const two = 2;');

    const files = scanDirectory(root);

    // Both committed and untracked source from the nested repos must be found.
    expect(files).toContain('sub_repo1/src/one.ts');
    expect(files).toContain('sub_repo2/src/two.ts');
  });

  it('should respect each embedded repo\'s own .gitignore', async () => {
    const { execFileSync } = await import('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });

    const root = path.join(tempDir, 'root');
    fs.mkdirSync(root, { recursive: true });
    git(root, 'init', '-q');

    const sub = path.join(root, 'sub_repo', 'src');
    fs.mkdirSync(sub, { recursive: true });
    git(path.join(root, 'sub_repo'), 'init', '-q');
    fs.writeFileSync(path.join(root, 'sub_repo', '.gitignore'), 'src/generated.ts\n');
    fs.writeFileSync(path.join(sub, 'real.ts'), 'export const real = 1;');
    fs.writeFileSync(path.join(sub, 'generated.ts'), 'export const generated = 1;');

    const files = scanDirectory(root);

    expect(files).toContain('sub_repo/src/real.ts');
    expect(files).not.toContain('sub_repo/src/generated.ts');
  });
});

// =============================================================================
// Scala
// =============================================================================

describe('Scala Extraction', () => {
  describe('Language detection', () => {
    it('should detect Scala files', () => {
      expect(detectLanguage('Main.scala')).toBe('scala');
      expect(detectLanguage('script.sc')).toBe('scala');
      expect(detectLanguage('src/UserService.scala')).toBe('scala');
    });

    it('should report Scala as supported', () => {
      expect(isLanguageSupported('scala')).toBe(true);
      expect(getSupportedLanguages()).toContain('scala');
    });
  });

  describe('Class extraction', () => {
    it('should extract class definitions', () => {
      const code = `
class UserService(private val repo: UserRepository) {
  def findUser(id: String): Option[String] = Some(id)
}
`;
      const result = extractFromSource('UserService.scala', code);
      const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'UserService');
      expect(cls).toBeDefined();
      expect(cls?.language).toBe('scala');
    });

    it('should extract object definitions as class kind', () => {
      const code = `
object DatabaseConfig {
  val url = "jdbc:postgresql://localhost/mydb"
}
`;
      const result = extractFromSource('Config.scala', code);
      const obj = result.nodes.find((n) => n.kind === 'class' && n.name === 'DatabaseConfig');
      expect(obj).toBeDefined();
    });

    it('should extract trait definitions as trait kind', () => {
      const code = `
trait Repository[A] {
  def findById(id: String): Option[A]
  def save(entity: A): Unit
}
`;
      const result = extractFromSource('Repository.scala', code);
      const trait_ = result.nodes.find((n) => n.kind === 'trait' && n.name === 'Repository');
      expect(trait_).toBeDefined();
    });
  });

  describe('Method and function extraction', () => {
    it('should extract method definitions inside a class', () => {
      const code = `
class Calculator {
  def add(a: Int, b: Int): Int = a + b
  def divide(a: Double, b: Double): Double = a / b
}
`;
      const result = extractFromSource('Calculator.scala', code);
      const methods = result.nodes.filter((n) => n.kind === 'method');
      expect(methods.find((m) => m.name === 'add')).toBeDefined();
      expect(methods.find((m) => m.name === 'divide')).toBeDefined();
    });

    it('should extract method signatures', () => {
      const code = `
class Greeter {
  def greet(name: String): String = s"Hello, \${name}!"
}
`;
      const result = extractFromSource('Greeter.scala', code);
      const method = result.nodes.find((n) => n.name === 'greet');
      expect(method?.signature).toContain('name: String');
      expect(method?.signature).toContain('String');
    });

    it('should extract top-level function definitions as functions', () => {
      const code = `
def factorial(n: Int): Int = if (n <= 1) 1 else n * factorial(n - 1)
def greet(name: String): String = s"Hello, \${name}!"
`;
      const result = extractFromSource('utils.scala', code);
      const fns = result.nodes.filter((n) => n.kind === 'function');
      expect(fns.find((f) => f.name === 'factorial')).toBeDefined();
      expect(fns.find((f) => f.name === 'greet')).toBeDefined();
    });
  });

  describe('Val and var extraction', () => {
    it('should extract val inside a class as field', () => {
      const code = `
class Config {
  val timeout: Int = 30
  val host: String = "localhost"
}
`;
      const result = extractFromSource('Config.scala', code);
      const fields = result.nodes.filter((n) => n.kind === 'field');
      expect(fields.find((f) => f.name === 'timeout')).toBeDefined();
      expect(fields.find((f) => f.name === 'host')).toBeDefined();
    });

    it('should extract var inside a class as field', () => {
      const code = `
class Counter {
  var count: Int = 0
}
`;
      const result = extractFromSource('Counter.scala', code);
      const field = result.nodes.find((n) => n.kind === 'field' && n.name === 'count');
      expect(field).toBeDefined();
    });

    it('should extract top-level val as constant', () => {
      const code = `
val MaxConnections: Int = 100
val DefaultTimeout = 30
`;
      const result = extractFromSource('constants.scala', code);
      const consts = result.nodes.filter((n) => n.kind === 'constant');
      expect(consts.find((c) => c.name === 'MaxConnections')).toBeDefined();
    });

    it('should extract top-level var as variable', () => {
      const code = `
var retries: Int = 3
`;
      const result = extractFromSource('state.scala', code);
      const v = result.nodes.find((n) => n.kind === 'variable' && n.name === 'retries');
      expect(v).toBeDefined();
    });

    it('should include type in val/var signature', () => {
      const code = `
class Service {
  val timeout: Int = 30
}
`;
      const result = extractFromSource('Service.scala', code);
      const field = result.nodes.find((n) => n.name === 'timeout');
      expect(field?.signature).toContain('timeout');
      expect(field?.signature).toContain('Int');
    });
  });

  describe('Enum extraction', () => {
    it('should extract enum definitions', () => {
      const code = `
enum Color:
  case Red
  case Green
  case Blue
`;
      const result = extractFromSource('Color.scala', code);
      const enumNode = result.nodes.find((n) => n.kind === 'enum' && n.name === 'Color');
      expect(enumNode).toBeDefined();
    });

    it('should extract enum cases as enum_member', () => {
      const code = `
enum Direction:
  case North
  case South
  case East
  case West
`;
      const result = extractFromSource('Direction.scala', code);
      const members = result.nodes.filter((n) => n.kind === 'enum_member');
      expect(members.find((m) => m.name === 'North')).toBeDefined();
      expect(members.find((m) => m.name === 'South')).toBeDefined();
      expect(members.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Type alias extraction', () => {
    it('should extract type aliases', () => {
      const code = `
type UserId = String
type UserMap = Map[String, String]
`;
      const result = extractFromSource('types.scala', code);
      const aliases = result.nodes.filter((n) => n.kind === 'type_alias');
      expect(aliases.find((a) => a.name === 'UserId')).toBeDefined();
      expect(aliases.find((a) => a.name === 'UserMap')).toBeDefined();
    });
  });

  describe('Import extraction', () => {
    it('should extract import declarations', () => {
      const code = `
import scala.collection.mutable.ListBuffer
import scala.concurrent.Future
`;
      const result = extractFromSource('imports.scala', code);
      const imports = result.nodes.filter((n) => n.kind === 'import');
      expect(imports.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Visibility modifiers', () => {
    it('should extract private visibility', () => {
      const code = `
class Service {
  private val secret: String = "abc"
  private def helper(): Unit = {}
}
`;
      const result = extractFromSource('Service.scala', code);
      const secretField = result.nodes.find((n) => n.name === 'secret');
      expect(secretField?.visibility).toBe('private');
      const helperMethod = result.nodes.find((n) => n.name === 'helper');
      expect(helperMethod?.visibility).toBe('private');
    });

    it('should extract protected visibility', () => {
      const code = `
class Base {
  protected def helperMethod(): Unit = {}
}
`;
      const result = extractFromSource('Base.scala', code);
      const method = result.nodes.find((n) => n.name === 'helperMethod');
      expect(method?.visibility).toBe('protected');
    });

    it('should default to public visibility', () => {
      const code = `
class Greeter {
  def hello(): Unit = {}
}
`;
      const result = extractFromSource('Greeter.scala', code);
      const method = result.nodes.find((n) => n.name === 'hello');
      expect(method?.visibility).toBe('public');
    });
  });

  describe('Inheritance', () => {
    it('should extract extends relationships', () => {
      const code = `
class AdminUser extends User {
  def adminAction(): Unit = {}
}
`;
      const result = extractFromSource('AdminUser.scala', code);
      const extendsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'extends');
      expect(extendsRefs.find((r) => r.referenceName === 'User')).toBeDefined();
    });
  });

  describe('Call extraction', () => {
    it('should extract function call expressions', () => {
      const code = `
def processData(): Unit = {
  val result = computeResult()
  println(result)
}
`;
      const result = extractFromSource('processor.scala', code);
      const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
      expect(calls.length).toBeGreaterThan(0);
    });
  });
});

describe('Vue Extraction', () => {
  it('should detect Vue files', () => {
    expect(detectLanguage('App.vue')).toBe('vue');
    expect(detectLanguage('components/Button.vue')).toBe('vue');
    expect(isLanguageSupported('vue')).toBe(true);
  });

  it('should extract component node from a Vue SFC', () => {
    const code = `<template>
  <div>{{ message }}</div>
</template>

<script>
export default {
  data() {
    return { message: 'Hello' };
  }
}
</script>
`;
    const result = extractFromSource('HelloWorld.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();
    expect(componentNode?.name).toBe('HelloWorld');
    expect(componentNode?.language).toBe('vue');
    expect(componentNode?.isExported).toBe(true);
  });

  it('should extract functions from <script> block', () => {
    const code = `<template>
  <button @click="handleClick">Click</button>
</template>

<script>
function handleClick() {
  console.log('clicked');
}

const count = 0;
</script>
`;
    const result = extractFromSource('Button.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();
    expect(componentNode?.name).toBe('Button');

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'handleClick');
    expect(funcNode).toBeDefined();
    expect(funcNode?.language).toBe('vue');
  });

  it('should extract from <script setup lang="ts"> block', () => {
    const code = `<template>
  <div>{{ count }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const count = ref(0);

function increment(): void {
  count.value++;
}
</script>
`;
    const result = extractFromSource('Counter.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();
    expect(componentNode?.name).toBe('Counter');

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'increment');
    expect(funcNode).toBeDefined();
    expect(funcNode?.language).toBe('vue');

    // All nodes should be marked as vue language
    for (const node of result.nodes) {
      expect(node.language).toBe('vue');
    }
  });

  it('should extract from both <script> and <script setup> blocks', () => {
    const code = `<template>
  <div>{{ msg }}</div>
</template>

<script>
export default {
  name: 'DualScript'
}
</script>

<script setup>
const msg = 'hello';

function greet() {
  return msg;
}
</script>
`;
    const result = extractFromSource('DualScript.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();

    const greetFunc = result.nodes.find((n) => n.kind === 'function' && n.name === 'greet');
    expect(greetFunc).toBeDefined();
  });

  it('should create component node for template-only Vue file', () => {
    const code = `<template>
  <div>Static content</div>
</template>
`;
    const result = extractFromSource('Static.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();
    expect(componentNode?.name).toBe('Static');
    expect(componentNode?.language).toBe('vue');

    // Only the component node should exist (no script nodes)
    expect(result.nodes.length).toBe(1);
  });

  it('should create containment edges from component to script nodes', () => {
    const code = `<template>
  <div>{{ value }}</div>
</template>

<script setup lang="ts">
const value = 42;
</script>
`;
    const result = extractFromSource('Contained.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();

    // Should have containment edges from component to child nodes
    const containEdges = result.edges.filter(
      (e) => e.source === componentNode!.id && e.kind === 'contains'
    );
    expect(containEdges.length).toBeGreaterThan(0);
  });
});

describe('Hybrid template extraction', () => {
  it('should extract Astro frontmatter imports, functions, inline scripts, and component references without file nodes', () => {
    const code = `---
import Header from '../components/Header.astro';
const title = makeTitle('Home');
function makeTitle(value: string) { return value; }
---
<Header title={title} />
<script>
function hydrate() { console.log('ready'); }
hydrate();
</script>
`;
    const result = extractFromSource('src/pages/index.astro', code);

    expect(result.nodes.filter((node) => node.kind === 'file')).toHaveLength(0);
    expect(result.nodes.find((node) => node.kind === 'component' && node.name === 'index')).toBeDefined();
    expect(result.nodes.find((node) => node.kind === 'function' && node.name === 'makeTitle')?.language).toBe('astro');
    expect(result.nodes.find((node) => node.kind === 'function' && node.name === 'hydrate')?.language).toBe('astro');
    expect(result.unresolvedReferences.find((ref) => ref.referenceName === 'Header' && ref.referenceKind === 'references')).toBeDefined();
  });

  it('should extract Jinja blocks and static template references', () => {
    const code = `{% extends "base.html" %}
{% block content %}
  {% include "partials/card.html" %}
{% endblock %}
`;
    const result = extractFromSource('templates/index.html', code);

    expect(result.nodes.find((node) => node.kind === 'file' && node.name === 'index.html')).toBeDefined();
    expect(result.nodes.find((node) => node.kind === 'component' && node.name === 'content')).toBeDefined();
    expect(result.unresolvedReferences.map((ref) => ref.referenceName).sort()).toEqual(['base.html', 'partials/card.html']);
  });

  it('should extract Razor model directives, partial references, and C# code blocks', () => {
    const code = `@model MyApp.Models.ProductViewModel
@{
  var label = FormatName(Model.Name);
}
@await Html.PartialAsync("_Summary", Model)
`;
    const result = extractFromSource('Views/Product/Details.cshtml', code);

    expect(result.nodes.find((node) => node.kind === 'file' && node.name === 'Details.cshtml')).toBeDefined();
    expect(result.nodes.find((node) => node.kind === 'type_alias' && node.name === 'ProductViewModel')).toBeDefined();
    expect(result.unresolvedReferences.find((ref) => ref.referenceName === 'ProductViewModel' && ref.referenceKind === 'type_of')).toBeDefined();
    expect(result.unresolvedReferences.find((ref) => ref.referenceName === 'Views/Product/_Summary.cshtml')).toBeDefined();
  });
});

describe('SQL Extraction', () => {
  it('should detect SQL files', () => {
    expect(detectLanguage('models/orders.sql')).toBe('sql');
  });

  it('should extract tables, views, functions, CTEs, queries, and static references', () => {
    const code = `
create table customers (
  id bigint primary key,
  email varchar(255) not null
);

create view active_customers as
select id, email
from customers;

create function normalize_email(input_email varchar)
returns varchar
return lower(trim(input_email));

with recent_orders as (
  select customer_id, count(*) as order_count
  from orders
  group by customer_id
)
select c.id, normalize_email(c.email), r.order_count
from active_customers c
join recent_orders r on r.customer_id = c.id;
`;
    const result = extractFromSource('models/customer_summary.sql', code);

    expect(result.errors).toHaveLength(0);
    expect(result.nodes.find((node) => node.kind === 'struct' && node.name === 'customers')).toBeDefined();
    expect(result.nodes.find((node) => node.kind === 'struct' && node.name === 'active_customers')).toBeDefined();
    expect(result.nodes.find((node) => node.kind === 'function' && node.name === 'normalize_email')).toBeDefined();
    expect(result.nodes.find((node) => node.kind === 'variable' && node.name === 'recent_orders')).toBeDefined();
    expect(result.nodes.find((node) => node.kind === 'function' && node.name.startsWith('query@'))).toBeDefined();
    expect(result.nodes.find((node) => node.kind === 'field' && node.name === 'email')).toBeDefined();
    expect(result.unresolvedReferences.find((ref) => ref.referenceName === 'customers' && ref.referenceKind === 'references')).toBeDefined();
    expect(result.unresolvedReferences.find((ref) => ref.referenceName === 'orders' && ref.referenceKind === 'references')).toBeDefined();
    expect(result.unresolvedReferences.find((ref) => ref.referenceName === 'normalize_email' && ref.referenceKind === 'calls')).toBeDefined();
  });
});

describe('Instantiates + Decorates edge extraction', () => {
  it('emits an instantiates ref for `new Foo()`', () => {
    const code = `
class Foo {}
function bootstrap() { return new Foo(); }
`;
    const result = extractFromSource('app.ts', code);
    const ref = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'instantiates' && r.referenceName === 'Foo'
    );
    expect(ref).toBeDefined();
  });

  it('strips type-argument suffix from generic constructors', () => {
    const code = `
class Container<T> { constructor(_: T) {} }
function go() { return new Container<string>('x'); }
`;
    const result = extractFromSource('app.ts', code);
    const ref = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'instantiates'
    );
    expect(ref).toBeDefined();
    // Container<string> must be normalised to "Container" — otherwise
    // resolution can never match the class node.
    expect(ref!.referenceName).toBe('Container');
  });

  it('keeps trailing identifier from qualified `new ns.Foo()`', () => {
    const code = `
const ns = { Foo: class {} };
function go() { return new ns.Foo(); }
`;
    const result = extractFromSource('app.ts', code);
    const ref = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'instantiates'
    );
    // We can't always resolve which Foo, but the name should be the
    // simple identifier so name-matching has a chance.
    expect(ref?.referenceName).toBe('Foo');
  });

  it('emits a decorates ref for `@Foo class X {}`', () => {
    const code = `
function Foo(_arg: string) { return (cls: any) => cls; }
@Foo('x')
class X {}
`;
    const result = extractFromSource('app.ts', code);
    const decorClass = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'decorates' && r.referenceName === 'Foo'
    );
    expect(decorClass).toBeDefined();
  });

  it('does NOT attribute a prior class\'s decorator to the next class', () => {
    // Regression: the sibling-walk must stop at the first non-
    // decorator separator. `@A class Foo {} @B class Bar {}` must
    // produce `decorates(Foo, A)` and `decorates(Bar, B)` — never
    // `decorates(Bar, A)`.
    const code = `
function A(cls: any) { return cls; }
function B(cls: any) { return cls; }
@A
class Foo {}
@B
class Bar {}
`;
    const result = extractFromSource('app.ts', code);
    const decoratesEdges = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'decorates'
    );
    // Exactly one decorates ref per decorated class, no cross-attribution.
    const fromBar = decoratesEdges.filter((r) =>
      result.nodes.find((n) => n.id === r.fromNodeId && n.name === 'Bar')
    );
    expect(fromBar.length).toBe(1);
    expect(fromBar[0]!.referenceName).toBe('B');
  });

  it('emits a decorates ref for `@Foo method() {}`', () => {
    const code = `
function Get(p: string) { return (t: any, k: string) => t; }
class Svc {
  @Get('/x') method() { return 1; }
}
`;
    const result = extractFromSource('app.ts', code);
    const decorMethod = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'decorates' && r.referenceName === 'Get'
    );
    expect(decorMethod).toBeDefined();
    // The decorated symbol must be `method`, not the constructor or class.
    const decoratedNode = result.nodes.find((n) => n.id === decorMethod!.fromNodeId);
    expect(decoratedNode?.name).toBe('method');
  });
});

// =============================================================================
// Lua
// =============================================================================

describe('Lua Extraction', () => {
  describe('Language detection', () => {
    it('should detect Lua files', () => {
      expect(detectLanguage('init.lua')).toBe('lua');
      expect(detectLanguage('src/util.lua')).toBe('lua');
    });

    it('should report Lua as supported', () => {
      expect(isLanguageSupported('lua')).toBe(true);
      expect(getSupportedLanguages()).toContain('lua');
    });
  });

  describe('Function extraction', () => {
    it('should extract global and local functions', () => {
      const code = `
function configure(opts) return opts end
local function helper(x) return x * 2 end
`;
      const result = extractFromSource('init.lua', code);
      const funcs = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
      expect(funcs).toContain('configure');
      expect(funcs).toContain('helper');
      const configure = result.nodes.find((n) => n.name === 'configure');
      expect(configure?.language).toBe('lua');
      expect(configure?.signature).toBe('(opts)');
    });

    it('should split table/method functions into a receiver and method name', () => {
      const code = `
function M.connect(host, port) return host end
function M:send(data) return self end
`;
      const result = extractFromSource('init.lua', code);
      const methods = result.nodes.filter((n) => n.kind === 'method');
      const connect = methods.find((m) => m.name === 'connect');
      expect(connect?.qualifiedName).toBe('M::connect');
      const send = methods.find((m) => m.name === 'send');
      expect(send?.qualifiedName).toBe('M::send');
    });
  });

  describe('Variable extraction', () => {
    it('should extract local variable declarations', () => {
      const code = `
local M = {}
local count = 0
`;
      const result = extractFromSource('mod.lua', code);
      const vars = result.nodes.filter((n) => n.kind === 'variable').map((n) => n.name);
      expect(vars).toContain('M');
      expect(vars).toContain('count');
    });
  });

  describe('Import extraction (require)', () => {
    it('should extract require() in local declarations and bare calls', () => {
      const code = `
local socket = require("socket")
local http = require "resty.http"
require("side.effect")
`;
      const result = extractFromSource('net.lua', code);
      const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(imports).toContain('socket');
      expect(imports).toContain('resty.http');
      expect(imports).toContain('side.effect');

      const ref = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'imports' && r.referenceName === 'socket'
      );
      expect(ref).toBeDefined();
    });

    // Regression: the tree-sitter-wasms Lua grammar (ABI 13) corrupts the shared
    // WASM heap under web-tree-sitter 0.25, dropping nested calls/imports on every
    // parse after the first. We vendor the ABI-15 grammar instead — this guards it
    // by extracting several sources in sequence and asserting the LAST still works.
    it('should keep extracting require across many sequential parses', () => {
      let last;
      for (let i = 0; i < 8; i++) {
        last = extractFromSource(`f${i}.lua`, `local m = require("module.${i}")\nreturn m\n`);
      }
      const imports = last!.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(imports).toContain('module.7');
    });
  });

  describe('Call extraction', () => {
    it('should record intra-file calls as resolvable references', () => {
      const code = `
local function helper(x) return x end
local function run(y) return helper(y) end
`;
      const result = extractFromSource('calls.lua', code);
      const call = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'calls' && r.referenceName === 'helper'
      );
      expect(call).toBeDefined();
    });
  });
});

// =============================================================================
// Luau (typed superset of Lua — https://luau.org)
// =============================================================================

describe('Luau Extraction', () => {
  describe('Language detection', () => {
    it('should detect Luau files', () => {
      expect(detectLanguage('init.luau')).toBe('luau');
      expect(detectLanguage('src/Client.luau')).toBe('luau');
    });

    it('should report Luau as supported', () => {
      expect(isLanguageSupported('luau')).toBe(true);
      expect(getSupportedLanguages()).toContain('luau');
    });
  });

  describe('Type aliases', () => {
    it('should extract `type` and `export type` definitions', () => {
      const code = `
export type Vector = { x: number, y: number }
type Handler = (msg: string) -> boolean
`;
      const result = extractFromSource('types.luau', code);
      const aliases = result.nodes.filter((n) => n.kind === 'type_alias');
      const vector = aliases.find((a) => a.name === 'Vector');
      expect(vector).toBeDefined();
      expect(vector?.isExported).toBe(true);
      const handler = aliases.find((a) => a.name === 'Handler');
      expect(handler).toBeDefined();
      expect(handler?.isExported).toBe(false);
    });
  });

  describe('Typed functions and methods', () => {
    it('should capture typed signatures and split methods by receiver', () => {
      const code = `
function configure(opts: { debug: boolean }): boolean
	return opts.debug
end
function Client:fetch(path: string): Response
	return path
end
`;
      const result = extractFromSource('client.luau', code);
      const configure = result.nodes.find((n) => n.kind === 'function' && n.name === 'configure');
      expect(configure?.language).toBe('luau');
      expect(configure?.signature).toBe('(opts: { debug: boolean }): boolean');
      const fetch = result.nodes.find((n) => n.kind === 'method' && n.name === 'fetch');
      expect(fetch?.qualifiedName).toBe('Client::fetch');
    });
  });

  describe('Imports and variables', () => {
    it('should extract string and Roblox instance-path require imports', () => {
      const code = `
local http = require("http")
local Signal = require(script.Parent.Signal)
local count = 0
`;
      const result = extractFromSource('mod.luau', code);
      const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(imports).toContain('http'); // string require
      expect(imports).toContain('Signal'); // Roblox instance-path require
      const vars = result.nodes.filter((n) => n.kind === 'variable').map((n) => n.name);
      expect(vars).toContain('count');
    });
  });
});

// =============================================================================
// =============================================================================
// Bash / sh
// =============================================================================

describe('Bash / sh Extraction', () => {
  describe('Language detection', () => {
    it('should detect Bash and sh-style files', () => {
      expect(detectLanguage('scripts/deploy.sh')).toBe('bash');
      expect(detectLanguage('scripts/helpers.bash')).toBe('bash');
      expect(detectLanguage('test/install.bats')).toBe('bash');
    });

    it('should report Bash as supported', () => {
      expect(isLanguageSupported('bash')).toBe(true);
      expect(getSupportedLanguages()).toContain('bash');
    });
  });

  it('should extract functions, sourced files, variables, and command calls statically', () => {
    const code = `
source ./lib/common.sh
. "\${HOME}/.profile"
ROOT_DIR="/srv/app"

log_info() {
  printf '%s\n' "$1"
}

function deploy_app() {
  log_info "deploying"
  run_step build
}
`;
    const result = extractFromSource('scripts/deploy.sh', code);

    expect(result.errors).toHaveLength(0);
    expect(result.nodes.find((n) => n.kind === 'file')?.language).toBe('bash');
    const funcs = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
    expect(funcs).toContain('log_info');
    expect(funcs).toContain('deploy_app');

    const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
    expect(imports).toContain('./lib/common.sh');
    expect(imports).toContain('${HOME}/.profile');
    const rootDir = result.nodes.find((n) => n.kind === 'variable' && n.name === 'ROOT_DIR');
    expect(rootDir?.signature).toBe('= "/srv/app"');

    expect(result.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ referenceKind: 'imports', referenceName: './lib/common.sh' }),
        expect.objectContaining({ referenceKind: 'calls', referenceName: 'log_info' }),
        expect.objectContaining({ referenceKind: 'calls', referenceName: 'run_step' }),
      ])
    );
  });

  it('should parse representative install scripts with case blocks, heredocs, and arithmetic checks', () => {
    const code = `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
source "\${SCRIPT_DIR}/install-common.sh"

print_usage() {
  cat <<USAGE
Usage: install-opencode.sh [--dry-run]
USAGE
}

main() {
  if (( $# > 0 )); then
    case "$1" in
      --help|-h)
        print_usage
        ;;
      --dry-run)
        echo "dry run"
        ;;
      *)
        echo "unknown option: $1"
        exit 1
        ;;
    esac
  fi

  install_agent "opencode"
}

main "$@"
`;

    const result = extractFromSource('install/install-opencode.sh', code);

    expect(result.errors).toHaveLength(0);
    expect(result.nodes.find((n) => n.kind === 'file')?.language).toBe('bash');
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'main')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'import' && n.name === '${SCRIPT_DIR}/install-common.sh')).toBeDefined();
    expect(result.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ referenceKind: 'calls', referenceName: 'print_usage' }),
        expect.objectContaining({ referenceKind: 'calls', referenceName: 'install_agent' }),
      ])
    );
  });
});

// =============================================================================
// PowerShell
// =============================================================================

describe('PowerShell Extraction', () => {
  describe('Language detection', () => {
    it('should detect PowerShell script and module files', () => {
      expect(detectLanguage('scripts/deploy.ps1')).toBe('powershell');
      expect(detectLanguage('modules/Tools.psm1')).toBe('powershell');
      expect(detectLanguage('modules/Tools.psd1')).toBe('powershell');
    });

    it('should report PowerShell as supported', () => {
      expect(isLanguageSupported('powershell')).toBe(true);
      expect(getSupportedLanguages()).toContain('powershell');
    });
  });

  it('should extract functions, classes, modules, dot-sourced scripts, and commands statically', () => {
    const code = `
using module ./Tools/Helpers.psm1
. ./scripts/common.ps1
Import-Module Pester
Import-Module ./BuildTools.psd1

class DeployPlan {
  [string] $Name
  DeployPlan([string] $name) { $this.Name = $name }
  [void] Run() { Invoke-BuildStep $this.Name }
}

function Invoke-Deploy {
  param([string] $Target)
  Write-Verbose "Deploying $Target"
  Invoke-BuildStep -Name $Target
}
`;
    const result = extractFromSource('scripts/deploy.ps1', code);

    expect(result.errors).toHaveLength(0);
    expect(result.nodes.find((n) => n.kind === 'file')?.language).toBe('powershell');
    expect(result.nodes.some((n) => n.kind === 'function' && n.name === 'Invoke-Deploy')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'DeployPlan')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'method' && n.name === 'Run')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'property' && n.name === 'Name')).toBe(true);

    const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
    expect(imports).toContain('./Tools/Helpers.psm1');
    expect(imports).toContain('./scripts/common.ps1');
    expect(imports).toContain('Pester');
    expect(imports).toContain('./BuildTools.psd1');

    expect(result.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ referenceKind: 'imports', referenceName: './Tools/Helpers.psm1' }),
        expect.objectContaining({ referenceKind: 'calls', referenceName: 'Write-Verbose' }),
        expect.objectContaining({ referenceKind: 'calls', referenceName: 'Invoke-BuildStep' }),
      ])
    );
  });
});
// Objective-C
// =============================================================================

describe('Objective-C Extraction', () => {
  const sample = `
#import <Foundation/Foundation.h>
#import "MyClass.h"

@interface MyClass : NSObject <NSCopying>
@property (nonatomic, copy) NSString *name;
- (void)greet;
- (void)doThing:(id)x with:(id)y;
+ (instancetype)shared;
@end

@implementation MyClass

- (void)greet {
    NSLog(@"Hello");
    [self doWork];
}

- (void)doThing:(id)x with:(id)y {
    [self notify:x];
}

+ (instancetype)shared {
    return [[MyClass alloc] init];
}

@end

void helperFunction(int count) {
    MyClass *obj = [MyClass shared];
    [obj greet];
}
`;

  it('should extract classes, methods, functions, and imports', () => {
    const result = extractFromSource('App.m', sample);

    const classes = result.nodes.filter((n) => n.kind === 'class');
    expect(classes.filter((c) => c.name === 'MyClass')).toHaveLength(1);

    const methods = result.nodes.filter((n) => n.kind === 'method');
    expect(methods.map((m) => m.name).sort()).toEqual(['doThing:with:', 'greet', 'shared']);

    const shared = methods.find((m) => m.name === 'shared');
    expect(shared?.isStatic).toBe(true);

    const properties = result.nodes.filter((n) => n.kind === 'property');
    expect(properties.some((p) => p.name === 'name')).toBe(true);

    const functions = result.nodes.filter((n) => n.kind === 'function');
    expect(functions.some((f) => f.name === 'helperFunction')).toBe(true);

    const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
    expect(imports).toContain('Foundation/Foundation.h');
    expect(imports).toContain('MyClass.h');
  });

  it('should record inheritance and protocol conformance', () => {
    const result = extractFromSource('App.m', sample);
    const extendsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'extends');
    const implementsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'implements');
    expect(extendsRefs.map((r) => r.referenceName)).toContain('NSObject');
    expect(implementsRefs.map((r) => r.referenceName)).toContain('NSCopying');
  });

  it('should record message sends and C calls', () => {
    const result = extractFromSource('App.m', sample);
    const calls = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'calls')
      .map((r) => r.referenceName);
    expect(calls).toEqual(expect.arrayContaining(['NSLog', 'doWork', 'MyClass.shared', 'obj.greet']));
  });

  it('should reconstruct multi-keyword selectors at the call site so they resolve to the method definition', () => {
    // Regression for the gap discovered post-#165: message_expression's
    // multi-keyword form `[obj a:1 b:2]` was only emitting the first keyword,
    // so calls never resolved to multi-part method definitions like
    // `GET:parameters:headers:progress:success:failure:`. The call-site name
    // must match the method-definition name with full keywords + trailing colons.
    const code = `
@implementation Caller
- (void)demo {
    NSMutableDictionary *d = [NSMutableDictionary new];
    [d setObject:@"v" forKey:@"k"];
    [d setObject:@"v2" forKey:@"k2" withRetry:@YES];
    [self touchesBegan:nil withEvent:nil];
}
@end
`;
    const result = extractFromSource('Caller.m', code);
    const calls = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'calls')
      .map((r) => r.referenceName);
    expect(calls).toEqual(
      expect.arrayContaining([
        'd.setObject:forKey:',
        'd.setObject:forKey:withRetry:',
        'touchesBegan:withEvent:',
      ])
    );
  });

  it('should not classify pure C headers with @end in comments as objc', () => {
    const cHeader = '/* @end of file */\n#ifndef STDIO_H\nvoid printf(const char *);\n#endif\n';
    expect(detectLanguage('stdio.h', cHeader)).toBe('c');
  });

  it('should extract protocol declarations', () => {
    const code = `
@protocol DataSource <NSObject>
- (NSInteger)numberOfItems;
@end
`;
    const result = extractFromSource('DataSource.h', code);
    const protocol = result.nodes.find((n) => n.kind === 'protocol' && n.name === 'DataSource');
    expect(protocol).toBeDefined();
  });

  it('should report Objective-C as supported', () => {
    expect(isLanguageSupported('objc')).toBe(true);
    expect(getSupportedLanguages()).toContain('objc');
  });
});

describe('Groovy Extraction', () => {
  it('should extract classes, methods, closure-valued functions, imports, and Gradle-style tasks', () => {
    // Given: a Groovy class, top-level closure, and Gradle task declaration.
    const code = `
package demo

import com.acme.Widget

class BillingService {
  BigDecimal total(List<Integer> amounts) {
    return amounts.collect { amount -> amount * 2 }.sum()
  }
}

def configureTask = { taskName -> println(taskName) }

task customTask {
  doLast {
    println 'done'
  }
}
`;

    // When: the pinned command-oriented Groovy grammar is extracted.
    const result = extractFromSource('build.gradle', code);

    // Then: declarations and each scope's calls are exact.
    expect(result.nodes.find((n) => n.kind === 'file')?.language).toBe('groovy');
    const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
    expect(imports).toContain('com.acme.Widget');

    const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'BillingService');
    expect(cls).toBeDefined();
    const method = result.nodes.find((n) => n.kind === 'method' && n.name === 'total');
    expect(method?.signature).toContain('BigDecimal');

    const functions = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
    expect(functions).toContain('configureTask');
    expect(functions).toContain('customTask');

    const callsFrom = (nodeId: string | undefined): string[] => result.unresolvedReferences
      .filter((reference) => reference.referenceKind === 'calls' && reference.fromNodeId === nodeId)
      .map((reference) => reference.referenceName);
    expect(callsFrom(method?.id)).toEqual(['amounts.collect', 'sum']);
    expect(callsFrom(result.nodes.find((n) => n.kind === 'function' && n.name === 'configureTask')?.id)).toEqual(['println']);
    expect(callsFrom(result.nodes.find((n) => n.kind === 'function' && n.name === 'customTask')?.id)).toEqual(['doLast', 'println']);
  });

  it('should distinguish modified declarations, imports, inheritance, and calls', () => {
    // Given: ordinary Groovy forms that the command grammar represents with generic units and blocks.
    const code = `
import static com.acme.MathTools.*
import com.acme.Legacy as Alias

public class BillingService extends BaseService implements Auditable, Closeable {
  private final def formatter = { value -> normalize(value) }

  protected static BigDecimal total(List<Integer> amounts) {
    if (amounts.isEmpty()) {
      return zero()
    }
    return amounts.collect { amount -> amount * 2 }.sum()
  }

  void close() {
    this.flush()
    println 'closed'
  }
}
`;

    // When: SolidKG extracts the source through the pinned native Groovy parser.
    const result = extractFromSource('src/BillingService.groovy', code);

    // Then: only source-backed declarations and normalized graph references are emitted.
    expect(result.nodes.filter((node) => node.kind === 'import').map((node) => node.name)).toEqual([
      'com.acme.MathTools.*',
      'com.acme.Legacy',
    ]);
    const cls = result.nodes.find((node) => node.kind === 'class' && node.name === 'BillingService');
    expect(cls).toMatchObject({ visibility: 'public' });
    const methods = result.nodes.filter((node) => node.kind === 'method');
    expect(methods.map((node) => node.name)).toEqual(['formatter', 'total', 'close']);
    expect(methods.find((node) => node.name === 'formatter')).toMatchObject({ visibility: 'private' });
    expect(methods.find((node) => node.name === 'total')).toMatchObject({ visibility: 'protected', isStatic: true });

    const referencesFrom = (nodeId: string | undefined, kind: string): string[] => result.unresolvedReferences
      .filter((reference) => reference.fromNodeId === nodeId && reference.referenceKind === kind)
      .map((reference) => reference.referenceName);
    expect(referencesFrom(cls?.id, 'extends')).toEqual(['BaseService']);
    expect(referencesFrom(cls?.id, 'implements')).toEqual(['Auditable', 'Closeable']);
    expect(referencesFrom(methods.find((node) => node.name === 'formatter')?.id, 'calls')).toEqual(['normalize']);
    expect(referencesFrom(methods.find((node) => node.name === 'total')?.id, 'calls')).toEqual([
      'amounts.isEmpty',
      'zero',
      'amounts.collect',
      'sum',
    ]);
    expect(referencesFrom(methods.find((node) => node.name === 'close')?.id, 'calls')).toEqual(['flush', 'println']);
  });

  it('should recover compact classes swallowed by wildcard imports', () => {
    // Given: the pinned grammar merges a class into the preceding wildcard import command.
    const code = `import static com.acme.MathTools.*
public class BillingService extends BaseService {
  BigDecimal total(List<Integer> amounts) { return amounts.sum() }
}`;

    // When: the compact source is extracted.
    const result = extractFromSource('src/BillingService.groovy', code);

    // Then: the source-backed class, method, inheritance, and call remain available.
    const cls = result.nodes.find((node) => node.kind === 'class' && node.name === 'BillingService');
    const method = result.nodes.find((node) => node.kind === 'method' && node.name === 'total');
    expect(cls).toMatchObject({ startLine: 2, visibility: 'public' });
    expect(method).toMatchObject({ startLine: 3 });
    expect(result.unresolvedReferences.filter((reference) => reference.fromNodeId === cls?.id).map((reference) => reference.referenceName)).toEqual(['BaseService']);
    expect(result.unresolvedReferences.filter((reference) => reference.fromNodeId === method?.id).map((reference) => reference.referenceName)).toEqual(['amounts.sum']);
  });

  it('should ignore import-looking text in comments and strings', () => {
    // Given: only one import line is syntax; the other two are inert source text.
    const code = `/*
import com.fake.Commented
*/
def text = '''
import com.fake.StringValue
'''
import com.acme.Widget`;

    // When: the command-oriented Groovy fallback extracts imports.
    const result = extractFromSource('src/Imports.groovy', code);

    // Then: only the AST-backed import is emitted.
    expect(result.nodes.filter((node) => node.kind === 'import').map((node) => node.name)).toEqual([
      'com.acme.Widget',
    ]);
  });

  it('should recover nested classes once with their hierarchy intact', () => {
    // Given: a wildcard import swallows a class containing another class in the pinned AST.
    const code = `import static com.acme.MathTools.*
class Outer {
  class Inner {
    void work() { println 'done' }
  }
}`;

    // When: merged-import recovery visits the class body.
    const result = extractFromSource('src/Outer.groovy', code);

    // Then: nested declarations are emitted once under their owning scopes.
    expect(result.nodes
      .filter((node) => node.kind === 'class')
      .map((node) => ({ name: node.name, qualifiedName: node.qualifiedName }))).toEqual([
        { name: 'Outer', qualifiedName: 'Outer' },
        { name: 'Inner', qualifiedName: 'Outer::Inner' },
      ]);
    expect(result.nodes
      .filter((node) => node.kind === 'method')
      .map((node) => ({ name: node.name, qualifiedName: node.qualifiedName }))).toEqual([
        { name: 'work', qualifiedName: 'Outer::Inner::work' },
      ]);
  });
});

describe('Visual Basic .NET Extraction', () => {
  it('should extract VB.NET modules, classes, functions, properties, imports, and fields', () => {
    const code = `
Imports System
Imports System.Collections.Generic

Namespace Legacy.Reporting
  Public Module ReportModule
    Public Property Title As String

    Public Function FormatName(ByVal name As String) As String
      Return name.Trim()
    End Function
  End Module

  Public Class CustomerReport
    Private _count As Integer

    Public Property Count As Integer
      Get
        Return _count
      End Get
      Set(value As Integer)
        _count = value
      End Set
    End Property

    Public Function Build(ByVal id As Integer) As String
      Return id.ToString()
    End Function
  End Class
End Namespace
`;
    const result = extractFromSource('Report.vb', code);

    expect(result.nodes.find((n) => n.kind === 'file')?.language).toBe('vbnet');
    const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
    expect(imports).toEqual(expect.arrayContaining(['System', 'System.Collections.Generic']));

    expect(result.nodes.find((n) => n.kind === 'module' && n.name === 'ReportModule')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'class' && n.name === 'CustomerReport')).toBeDefined();

    const methods = result.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
    expect(methods).toEqual(expect.arrayContaining(['FormatName', 'Build']));

    const properties = result.nodes.filter((n) => n.kind === 'property').map((n) => n.name);
    expect(properties).toEqual(expect.arrayContaining(['Title', 'Count']));

    const countField = result.nodes.find((n) => n.kind === 'field' && n.name === '_count');
    expect(countField?.visibility).toBe('private');
  });
});

describe('Verilog / SystemVerilog Extraction', () => {
  it('should extract modules, classes, functions, enum types, fields, imports, and calls', () => {
    const code = `
import uvm_pkg::*;

module adder #(parameter WIDTH = 8) (
  input logic [WIDTH-1:0] a,
  input logic [WIDTH-1:0] b,
  output logic [WIDTH:0] sum
);
  typedef enum logic [1:0] {IDLE, RUN} state_t;
  function automatic logic [WIDTH:0] add(input logic [WIDTH-1:0] x, input logic [WIDTH-1:0] y);
    add = x + y;
  endfunction
  always_comb begin
    sum = add(a, b);
  end
endmodule

class packet;
  rand bit [7:0] data;
  function new(bit [7:0] value);
    data = value;
  endfunction
endclass
`;
    const result = extractFromSource('adder.sv', code);

    expect(result.errors).toHaveLength(0);
    expect(result.nodes.find((n) => n.kind === 'file')?.language).toBe('systemverilog');
    expect(result.nodes.find((n) => n.kind === 'module' && n.name === 'adder')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'class' && n.name === 'packet')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'add')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'enum' && n.name === 'state_t')).toBeDefined();
    expect(result.nodes.filter((n) => n.kind === 'enum_member').map((n) => n.name)).toEqual(expect.arrayContaining(['IDLE', 'RUN']));
    expect(result.nodes.find((n) => n.kind === 'field' && n.name === 'data')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'import' && n.name === 'uvm_pkg')).toBeDefined();
    expect(result.unresolvedReferences.some((ref) => ref.referenceKind === 'calls' && ref.referenceName === 'add')).toBe(true);
  });
});

describe('Julia Extraction', () => {
  it('should extract modules, structs, functions, macros, imports, variables, and calls', () => {
    const code = `
using LinearAlgebra

module Stats
export mean_value, Accumulator

struct Accumulator
    total::Float64
end

function mean_value(xs::Vector{Float64})::Float64
    total = sum(xs)
    return total / length(xs)
end

macro checked(expr)
    return esc(expr)
end
end
`;
    const result = extractFromSource('Stats.jl', code);

    expect(result.errors).toHaveLength(0);
    expect(result.nodes.find((n) => n.kind === 'file')?.language).toBe('julia');
    expect(result.nodes.find((n) => n.kind === 'import' && n.name === 'LinearAlgebra')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'module' && n.name === 'Stats')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'struct' && n.name === 'Accumulator')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'mean_value')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'checked')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'variable' && n.name === 'total')).toBeDefined();
    const calls = result.unresolvedReferences.filter((ref) => ref.referenceKind === 'calls').map((ref) => ref.referenceName);
    expect(calls).toEqual(expect.arrayContaining(['sum', 'length', 'esc']));
  });
});

describe('Fortran Extraction', () => {
  it('should extract modules, derived types, procedures, use imports, fields, variables, and calls', () => {
    const code = `
module linalg
  use iso_fortran_env, only: real64
  implicit none
  type :: vector
     real :: x
     real :: y
  end type vector
contains
  function norm2(v) result(r)
    type(vector), intent(in) :: v
    real :: r
    r = sqrt(v%x * v%x + v%y * v%y)
  end function norm2

  subroutine scale(v, factor)
    type(vector), intent(inout) :: v
    real, intent(in) :: factor
    call normalize(factor)
  end subroutine scale
end module linalg
`;
    const result = extractFromSource('linalg.f90', code);

    expect(result.errors).toHaveLength(0);
    expect(result.nodes.find((n) => n.kind === 'file')?.language).toBe('fortran');
    expect(result.nodes.find((n) => n.kind === 'module' && n.name === 'linalg')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'import' && n.name === 'iso_fortran_env')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'struct' && n.name === 'vector')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'norm2')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'scale')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'field' && n.name === 'x')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'variable' && n.name === 'factor')).toBeDefined();
    const calls = result.unresolvedReferences.filter((ref) => ref.referenceKind === 'calls').map((ref) => ref.referenceName);
    expect(calls).toEqual(expect.arrayContaining(['sqrt', 'normalize']));
  });
});

describe('R Extraction', () => {
  it('should extract R6 classes, functions, fields, package imports, source imports, variables, and calls', () => {
    const code = `
library(stats)
source("helpers.R")

threshold <- 10

Accumulator <- R6::R6Class("Accumulator",
  public = list(
    total = 0,
    add = function(value) {
      self$total <- self$total + value
      normalize(value)
    }
  )
)

normalize <- function(x) {
  sqrt(x)
}
`;
    const result = extractFromSource('model.R', code);

    expect(result.errors).toHaveLength(0);
    expect(result.nodes.find((n) => n.kind === 'file')?.language).toBe('r');
    expect(result.nodes.find((n) => n.kind === 'import' && n.name === 'stats')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'import' && n.name === 'helpers.R')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'variable' && n.name === 'threshold')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'class' && n.name === 'Accumulator')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'field' && n.name === 'total')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'add')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'normalize')).toBeDefined();
    const calls = result.unresolvedReferences.filter((ref) => ref.referenceKind === 'calls').map((ref) => ref.referenceName);
    expect(calls).toEqual(expect.arrayContaining(['normalize', 'sqrt']));
  });
});
