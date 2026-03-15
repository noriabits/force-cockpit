import { ReactivateOmniscriptService } from './ReactivateOmniscriptService';
import { defineFeature } from '../../defineFeature';

export const reactivateOmniscriptFeature = defineFeature({
  id: 'reactivate-omniscript',
  tab: 'utils',
  Service: ReactivateOmniscriptService,
  routes: (svc) => ({
    reactivateOmniscriptFetch: {
      handler: async () => ({
        records: await svc.fetchOmniscripts(),
      }),
      successType: 'reactivateOmniscriptFetchResult',
      errorType: 'reactivateOmniscriptFetchError',
    },
    reactivateOmniscript: {
      handler: async (msg) => svc.reactivate(msg.omniscriptId as string),
      successType: 'reactivateOmniscriptResult',
      errorType: 'reactivateOmniscriptError',
    },
  }),
});
