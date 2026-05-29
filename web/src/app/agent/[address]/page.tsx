// Server wrapper: enables static export for this dynamic route.
import View from "./View";

export const dynamicParams = false;
export function generateStaticParams() {
  return [{ address: "__address__" }];
}

export default function Page() {
  return <View />;
}
