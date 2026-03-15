import { CloneUserService } from './CloneUserService';
import { defineFeature } from '../../defineFeature';

export const cloneUserFeature = defineFeature({
  id: 'clone-user',
  tab: 'utils',
  Service: CloneUserService,
  routes: (svc) => ({
    cloneUserSearch: {
      handler: async (msg) => ({
        records: await svc.searchUsers(msg.searchTerm as string),
      }),
      successType: 'cloneUserSearchResult',
      errorType: 'cloneUserSearchError',
    },
    cloneUser: {
      handler: async (msg) =>
        svc.cloneUser({
          sourceUserId: msg.sourceUserId as string,
          firstName: msg.firstName as string,
          lastName: msg.lastName as string,
          email: msg.email as string,
        }),
      successType: 'cloneUserResult',
      errorType: 'cloneUserError',
    },
  }),
});
