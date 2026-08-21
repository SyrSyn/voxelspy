import { lazy, Suspense, useEffect, useState } from "react";
import { SamplePreview } from "./SamplePreview";

const HomeDemoClient = lazy(async () => {
  const module = await import("./HomeDemoClient");
  return { default: module.HomeDemoClient };
});

export function HomeDemo() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // The home page carries its own heading, so the sample sits beneath it.
  if (!mounted) return <SamplePreview headingLevel={2} />;
  return (
    <Suspense fallback={<SamplePreview headingLevel={2} />}>
      <HomeDemoClient />
    </Suspense>
  );
}
