import { Suspense } from "react";
import { Skeleton } from "@/components/ui";
import TemplateEditor from "./TemplateEditor";

export default function Page() {
  return (
    <Suspense fallback={<Skeleton h={480} />}>
      <TemplateEditor />
    </Suspense>
  );
}
