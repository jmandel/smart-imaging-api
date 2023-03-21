import { writable } from "svelte/store";

import * as fhirclient from "fhirclient";
import type Client from "fhirclient/lib/Client";
import type * as ftypes from "fhirclient/lib/types";

type ModifiedClient = Client & {
  images: () => Promise<any>;
};
export type { ModifiedClient as Client };

export type ClientConfig = ftypes.fhirclient.AuthorizeParams & {
  imagingServer: string;
};

export function create(config: ClientConfig) {
  const client = writable<ModifiedClient>(null);
  const authorize = () => {
    sessionStorage.setItem("imagingServer", config.imagingServer);
    fhirclient.oauth2.authorize(config);
  };

  try {
    fhirclient.oauth2.ready().then((c) => {
      const cstate = c.state as typeof c.state & ClientConfig;
      (c as unknown as ModifiedClient).images = async function images() {
        const ibundle = await c.request(
          sessionStorage.getItem("imagingServer") + "/ImagingStudy?patient=" + cstate.tokenResponse.patient
        );
        return ibundle;
      };
      client.set(c as ModifiedClient);
    });
  } catch {}
  return { client, authorize };
}
