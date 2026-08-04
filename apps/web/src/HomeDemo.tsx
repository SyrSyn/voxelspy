import { lazy, Suspense, useEffect, useState } from "react";
import { SamplePreview } from "./SamplePreview";

const HomeDemoClient = lazy(async () => {
  const module = await import("./HomeDemoClient");
  return { default: module.HomeDemoClient };
});

export function HomeDemo() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return <SamplePreview />;
  return (
    <Suspense fallback={<SamplePreview />}>
      <HomeDemoClient />
    </Suspense>
  );
}
