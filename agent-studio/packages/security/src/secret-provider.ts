/**
 * secret-provider.ts — secret references, not values
 * Source: agent_studio_implementation_plan.md:356-364, 605
 * Secrets are references to secret manager / workload identity, never values in .env.example.
 * Provider credentials never in workflow input/logs/definitions/capability claims.
 */

export interface SecretRef {
  ref: string; // e.g., "arn:aws:secretsmanager:us-east-1:123:secret:openai"
  version?: string;
}

export interface SecretProvider {
  resolve(ref: SecretRef): Promise<string>;
}

export class InMemorySecretProvider implements SecretProvider {
  private readonly store = new Map<string, Map<string, string>>(); // ref -> version -> value
  private readonly currentVersion = new Map<string, string>();

  set(ref: string, value: string, version = 'v1'): void {
    let versions = this.store.get(ref);
    if (!versions) {
      versions = new Map();
      this.store.set(ref, versions);
    }
    versions.set(version, value);
    this.currentVersion.set(ref, version);
  }

  /** Rotate without downtime — keeps previous version for overlap (308-314) */
  rotate(ref: string, newValue: string, newVersion: string): void {
    let versions = this.store.get(ref);
    if (!versions) {
      versions = new Map();
      this.store.set(ref, versions);
    }
    versions.set(newVersion, newValue);
    this.currentVersion.set(ref, newVersion);
    // Previous version retained for overlap; callers with old version still resolve
  }

  async resolve(ref: SecretRef): Promise<string> {
    const versions = this.store.get(ref.ref);
    if (!versions) throw new Error(`secret not found: ${ref.ref}`);
    const version = ref.version ?? this.currentVersion.get(ref.ref) ?? 'v1';
    const v = versions.get(version);
    if (v === undefined) throw new Error(`secret version not found: ${ref.ref}@${version}`);
    return v;
  }

  /** For tests: ensure no secret value appears in logs/history — use redaction */
  static assertNoPlaintextInLog(log: string, secretValue: string): void {
    if (log.includes(secretValue)) throw new Error('secret plaintext leaked in log');
  }
}

export class EnvSecretProvider implements SecretProvider {
  async resolve(ref: SecretRef): Promise<string> {
    const v = process.env[ref.ref];
    if (!v) throw new Error(`secret env not set: ${ref.ref}`);
    return v;
  }
}
