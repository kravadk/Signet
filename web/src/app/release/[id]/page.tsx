// Server wrapper: enables static export for this dynamic route.
// A single placeholder is prebuilt; the client View reads the real id from the
// URL at runtime, so any release id works on a static host.
import View from "./View";

export const dynamicParams = false;
export function generateStaticParams() {
  return [{ id: "__id__" }];
}

export default function Page() {
  return <View />;
}
