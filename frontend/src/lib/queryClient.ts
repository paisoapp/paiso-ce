import { QueryClient } from "@tanstack/react-query";

// Single app-wide client. Exported from its own module (rather than defined in
// App.tsx) so non-component code — notably the auth store — can clear it when
// the signed-in user changes. Without that, an in-SPA account switch would keep
// the previous user's cached data (a correctness *and* privacy problem).
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});
