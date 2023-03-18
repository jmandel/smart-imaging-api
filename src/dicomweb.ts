import { jose, Router } from "./deps.ts";
import { AppState, FhirResponse, Identifier, Patient, QidoResponse, TAGS } from "./types.ts";

const ephemeralKey = new Uint8Array(32);
crypto.getRandomValues(ephemeralKey);

const signStudyUid = async (uid: string, patient: string) => {
  return await new jose.SignJWT({ uid, patient })
    .setIssuedAt()
    .setExpirationTime("1 day")
    .setProtectedHeader({
      alg: "HS256",
    })
    .sign(ephemeralKey);
};

type DicomProviderConfig = {
  type: "dicom-web";
  lookup: "studies-by-mrn" | "all-studies-on-server";
  endpoint: string;
  authentication: {
    type: "http-basic";
    username: string;
    password: string;
  };
};

interface DicomWebResult {
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
}

function formatName(name: string): string | undefined {
  return name ? name.split("^").map(n => n.trim()).filter(n => !!n).join(" ") : undefined;
}

function formatDate(dateString: string, timeString?: string):string | undefined {
  if (!dateString) return undefined;
  const date = dateString.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  if (!timeString) return new Date(date).toISOString();

  const time = timeString.replace(/(\d{2})(\d{2})(\d{2})(\.\d{1,6})?/, '$1:$2:$3$4');
  return new Date(`${date}T${time}`).toISOString();
}


function formatResource(q, patient: Patient, wadoBase: string): any {

  const uid = q[TAGS.STUDY_UID].Value[0];
  const studyDateTime = formatDate(q[TAGS.STUDY_DATE].Value?.[0], q[TAGS.STUDY_TIME].Value?.[0]);

  return {
    resourceType: "ImagingStudy",
    status: "available",
    id: q[TAGS.STUDY_UID].Value[0],
    subject: {
      display: formatName(q[TAGS.PATIENT_NAME]?.Value?.[0]?.Alphabetic),
    },
    started: studyDateTime,
    referrer: {
      display: formatName(q[TAGS.REFERRING_PHYSICIAN_NAME]?.Value?.[0]?.Alphabetic),
    },
    description: q[TAGS.STUDY_ID]?.Value,
    numberOfSeries: q[TAGS.NUMBER_OF_SERIES]?.Value?.[0],
    numberOfInstances: q[TAGS.NUMBER_OF_INSTANCES]?.Value?.[0],
    contained: [
      {
        resourceType: "Endpoint",
        id: "e",
        address: `${wadoBase}/${signStudyUid(uid, patient.id)}`,
        connectionType: {
          system: "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
          code: "dicom-wado-rs",
        },
      },
    ],
    endpoint: { reference: "#e" },
    identifier: [{ system: "urn:dicom:uid", value: `urn:oid:${uid}` }],
    modality: q[TAGS.MODALITIES_IN_STUDY].Value.map((code: string) => ({
      system: `http://dicom.nema.org/resources/ontology/DCM`,
      code,
    })),
  };
}

export class DicomProvider {
  constructor(public config: DicomProviderConfig, public wadoBase: string) {}
  authHeader() {
    return `Basic ${btoa(`${this.config.authentication.username}:${this.config.authentication.password}`)}`;
  }
  async evaluateDicomWeb(path: string, reqHeaders: Headers): Promise<DicomWebResult> {
    const proxied = await fetch(`${this.config.endpoint}/studies/${path}`, {
      headers: {
        authorization: this.authHeader(),
        accept: reqHeaders.get("accept") || `multipart/related; type=application/dicom; transfer-syntax=*`,
      },
    });
    const headers: Record<string, string> = {};
    ["content-type", "content-length"].map((h) => {
      if (proxied.headers.get(h)) {
        headers[h] = proxied.headers.get(h)!;
      }
    });

    return { headers, body: proxied.body! };
  }

  async lookupStudies(patient: Patient): Promise<FhirResponse> {
    let query = ``;
    if (this.config.lookup === "studies-by-mrn") {
      const mrnIdentifier = patient.identifier.filter((i: Identifier) => i?.type?.text?.match("Medical Record Number"));
      const mrn = mrnIdentifier[0].value;
      console.log("MRN", mrn);
      query = `PatientID=${mrn}`;
    }
    const qido = new URL(`${this.config.endpoint}/studies?${query}`);
    console.log("Q", qido);
    const studies: QidoResponse = await fetch(qido, {
      headers: {
        authorization: this.authHeader(),
      },
    }).then((q) => q.json());
    console.log("Studies", studies);
    return {
      resourceType: "Bundle",
      entry: studies.map((q) => ({resource: formatResource(q, patient, this.wadoBase)}))
    };
  }
}

const wadoInnerRouter = new Router<AppState>().get("/studies/:uid(.*)", async (ctx) => {
  const { headers, body } = await ctx.state.imagesProvider.evaluateDicomWeb(`${ctx.params.uid}`, ctx.request.headers);
  Object.entries(headers).forEach(([k, v]) => {
    ctx.response.headers.set(k, v);
  });
  ctx.response.body = body;
});

export const wadoRouter = new Router<AppState>()
  .all("/:studyPatientBinding/studies/:uid/(.*)", async (ctx, next) => {
    const token = await jose.compactVerify(ctx.params.studyPatientBinding, ephemeralKey);
    const { uid, patient }: { uid: string; patient: string } = JSON.parse(new TextDecoder().decode(token.payload));
    if (patient !== ctx.state.authorizedForPatient.id) {
      throw `Patient mismatch: ${patient} vs ${ctx.state.authorizedForPatient.id}`;
    }
    if (uid !== ctx.params.uid) {
      throw `Study uid mismatch: ${uid} vs ${ctx.params.uid}`;
    }

    console.log("SPB", ctx.params.studyPatientBinding, ctx.state);
    await next();
  })
  .use("/:studyPatientBinding", wadoInnerRouter.routes());
