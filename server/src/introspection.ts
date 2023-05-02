import { jose, oak } from "./deps.ts";
import { AppState, IntrospectionResponse, Patient } from "./types.ts";

interface IntrospectionConfigBase {
  fhirBaseUrl: string;
  scope: string;
  client: {
    client_id: string;
    jwk: { alg: "ES384" | "RS384"; kid: string };
    jwkPrivate: unknown;
  };
}

type IntrospectionConfigMock = IntrospectionConfigBase & {
  type: "mock";
  patient?: Patient;
  disabled?: boolean;
};

type IntrospectionConfigMeditech = IntrospectionConfigBase & {
  type: "smart-on-fhir-with-meditech-bugfixes";
  client: { client_secret: string };
};

type IntrospectionConfig =
  & IntrospectionConfigBase
  & (
    | { type: "smart-on-fhir" }
    | { type: "smart-on-fhir-with-epic-bugfixes" }
    | IntrospectionConfigMeditech
    | IntrospectionConfigMock
  );

interface SmartConfiguration {
  token_endpoint: string;
  introspection_endpoint: string;
  issuer?: string;
  jwks_uri?: string;
}

interface AuthorizationAssignment {
  patient?: Patient;
  introspected?: IntrospectionResponse;
  disableAccessControl?: boolean;
  ehrBaseUrl?: string;
}

export class Introspection {
  public cache: { smartConfiguration?: SmartConfiguration } = {};
  static create(config: IntrospectionConfig): Introspection {
    if (config.type === "smart-on-fhir-with-epic-bugfixes") {
      return new IntrospectionEpic(config);
    } else if (config.type === "smart-on-fhir-with-meditech-bugfixes") {
      return new IntrospectionMeditech(config);
    } else if (config.type === "mock") {
      return new IntrospectionMock(config);
    } else {
      return new Introspection(config);
    }
  }

  constructor(public config: IntrospectionConfig) {}

  async getSmartConfiguration() {
    if (!this.cache.smartConfiguration) {
      const smartConfig = await fetch(
        `${this.config.fhirBaseUrl}/.well-known/smart-configuration`,
        {
          headers: { accept: "application/json" },
        },
      );
      const smartConfigJson = await smartConfig.json();
      this.cache.smartConfiguration = smartConfigJson as SmartConfiguration;
    }

    return this.cache.smartConfiguration;
  }

  async tokenEndpoint() {
    return (await this.getSmartConfiguration()).token_endpoint;
  }

  async introspectionEndpoint() {
    return (await this.getSmartConfiguration()).introspection_endpoint;
  }

  async generateClientAssertion() {
    return new jose.SignJWT({})
      .setIssuer(this.config.client.client_id)
      .setSubject(this.config.client.client_id)
      .setAudience(await this.tokenEndpoint())
      .setExpirationTime("3 minutes")
      .setJti(crypto.randomUUID())
      .setProtectedHeader({
        alg: this.config.client.jwk.alg,
        kid: this.config.client.jwk.kid,
        typ: "JWT",
      })
      .sign(await jose.importJWK(this.config.client.jwkPrivate as jose.JWK));
  }

  async getAccessToken() {
    const accessTokenResponse = await fetch(await this.tokenEndpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams([
        ["scope", this.config.scope],
        ["grant_type", "client_credentials"],
        ["client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"],
        ["client_assertion", await this.generateClientAssertion()],
      ]).toString(),
    });

    const accessTokenJson = await accessTokenResponse.json();
    return accessTokenJson as { access_token: string; expires_in: number };
  }

  async introspect(tokenToIntrospect: string, accessToken: string) {
    const introspectionResponse = await fetch(await this.introspectionEndpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${accessToken}`,
      },
      body: new URLSearchParams([["token", tokenToIntrospect]]).toString(),
    });
    return (await introspectionResponse.json()) as IntrospectionResponse;
  }

  async resolvePatient(
    introspected: IntrospectionResponse,
    accessToken: string,
  ): Promise<Patient | null> {
    if (!introspected.patient) {
      return null;
    }
    const patientUrl = this.config.fhirBaseUrl + "/Patient/" + introspected.patient;
    const patientResponse = await fetch(patientUrl, {
      method: "GET",
      headers: {
        accept: "application/fhir+json",
        authorization: `Bearer ${accessToken}`,
      },
    });

    return (await patientResponse.json()) as Patient;
  }

  allowsImaging(introspected: IntrospectionResponse) {
    const scopes = introspected.scope.split(/\s+/);
    return [
      "patient/*.*",
      "patient/*.read",
      "patient/*.rs",
      "patient/ImagingStudy.read",
      "patient/ImagingStudy.*",
      "patient/ImagingStudy.rs",
    ].some((s) => scopes.includes(s));
  }

  async getAuthorizationContext(tokenToIntrospect: string) {
    const accessToken = (await this.getAccessToken()).access_token;
    const introspected = await this.introspect(tokenToIntrospect, accessToken);
    console.log("Introspected", introspected);
    const patient = await this.resolvePatient(introspected, accessToken);
    console.log("P", patient);
    return { patient, introspected };
  }

  async assignAuthorization(ctx: oak.Context<AppState>): Promise<AuthorizationAssignment> {
    const tokenToIntrospect = ctx.request.headers.get("authorization")?.split(/bearer /i)?.[1];
    if (!tokenToIntrospect) {
      throw "Cannot authorize without an access token";
    }
    const { patient, introspected } = await this.getAuthorizationContext(tokenToIntrospect);
    if (!introspected.active) {
      throw "Must have an active access token";
    }
    if (!this.allowsImaging(introspected)) {
      throw "Must have imaging scopes";
    }
    if (!patient?.id) {
      throw "Must be authorized against a patient";
    }
    return { patient, introspected, ehrBaseUrl: this.config.fhirBaseUrl };
  }
}

export class IntrospectionEpic extends Introspection {
  async introspectionEndpoint() {
    const tokenEndpoint = await this.tokenEndpoint();
    return tokenEndpoint.replace(/\/token$/, "/introspect");
  }

  constructor(config: IntrospectionConfig) {
    super(config);
  }

  async resolvePatient(
    introspected: IntrospectionResponse,
    accessToken: string,
  ): Promise<Patient | null> {
    if (!introspected.sub) {
      return null;
    }
    const patientResponse = await fetch(introspected.sub, {
      method: "GET",
      headers: {
        accept: "application/fhir+json",
        authorization: `Bearer ${accessToken}`,
      },
    });

    return (await patientResponse.json()) as Patient;
  }

  allowsImaging(introspected: IntrospectionResponse): boolean {
    const scopes = introspected.scope.split(/\s+/);
    return ["patient/DiagnosticReport.read", "patient/ImagingStudy.read"].some((s) =>
      scopes.includes(s)
    );
  }
}

export class IntrospectionJwtVerifyTODO extends Introspection {
  constructor(config: IntrospectionConfig) {
    super(config);
  }
  async _TODOgetAuthorizationContext(tokenToIntrospect: string) {
    const { issuer, jwks_uri } = await this.getSmartConfiguration();
    if (!issuer || !jwks_uri) {
      throw "Access token decoding requires issuer and jwks_uri to be discoverable";
    }

    const jwks = await (await fetch(jwks_uri)).json();
    const keySet = await jose.createLocalJWKSet(jwks);
    const { payload, _protectedHeader } = (await jose.jwtVerify(tokenToIntrospect, keySet)) as any;

    const introspectionResponse = {
      active: true,
      patient: payload as any, // TODO finish this
    };
    return introspectionResponse;
  }
}

export class IntrospectionMeditech extends Introspection {

  // Workaround #1 -- one client can't introspect another client's
  // token, so we're using the same client ID in app + resource server
  // (This will prevent real-world deployment.)

  // Workaround #2 -- no patient id is supplied in introspection response
  // (This will prevent real-world deployment.)

  // Workaround #3 -- using app's access token to fetch patient
  // (This would likely prevent real-world deployment.)

  // Workaround #4 -- no backend services; so here, we're using
  // app's credential with client_basic to call introspection
  // (This is non-standard but won't prevent real-world deployment.)

  private queriedPatientId: string | null = null;

  constructor(public meditechConfig: IntrospectionConfigMeditech) {
    super(meditechConfig);
  }

  async introspect(tokenToIntrospect: string, _accessToken: string) {
    const authorization = `Basic ${
      btoa(
        `${this.config.client.client_id}:${this.meditechConfig.client.client_secret}`,
      )
    }`;
    const introspectionResponse = await fetch(await this.introspectionEndpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization,
      },
      body: new URLSearchParams([["token", tokenToIntrospect]]).toString(),
    });

    const ret = (await introspectionResponse.json()) as IntrospectionResponse;
    ret.patient = this.queriedPatientId!;
    return ret;
  }

  async assignAuthorization(
    ctx: oak.Context<AppState, Record<string, any>>,
  ): Promise<AuthorizationAssignment> {
    this.queriedPatientId = ctx.request.url.searchParams.get("patient")?.split("/").slice(-1)[0]!;
    return await super.assignAuthorization(ctx);
  }

  async getAuthorizationContext(tokenToIntrospect: string) {
    const introspected = await this.introspect(tokenToIntrospect, "");
    const patient = await this.resolvePatient(introspected, tokenToIntrospect);
    return { patient, introspected };
  }

  allowsImaging(introspected: IntrospectionResponse): boolean {
    const scopes = introspected.scope.split(/\s+/);
    return ["patient/DiagnosticReport.read", "patient/ImagingStudy.read"].some((s) => scopes.includes(s));
  }
}

export class IntrospectionMock extends Introspection {
  constructor(public mockConfig: IntrospectionConfigMock) {
    super(mockConfig);
  }

  // deno-lint-ignore require-await
  async assignAuthorization(_ctx: oak.Context<AppState>) {
    if (this.mockConfig.disabled) {
      return {
        disableAccessControl: true,
      };
    }

    return {
      patient: this.mockConfig.patient!,
      introspected: {
        active: true,
        patient: this.mockConfig.patient!.id,
        scope: "patient/ImagingStudy.rs",
      },
      ehrBaseUrl: this.mockConfig.fhirBaseUrl,
    };
  }
}
