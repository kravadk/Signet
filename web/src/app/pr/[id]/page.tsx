// Server wrapper: enables static export for this dynamic route.
import View from "./View";

export const dynamicParams = false;
export function generateStaticParams() {
  return [{ id: "__id__" }];
}

export default function Page() {
  return <View />;
}
