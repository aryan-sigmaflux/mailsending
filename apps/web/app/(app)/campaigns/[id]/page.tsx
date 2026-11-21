import { Suspense } from "react";
import { Skeleton } from "@/components/ui";
import CampaignView from "./CampaignView";

export default function Page() {
  return (
    <Suspense fallback={<Skeleton h={500} />}>
      <CampaignView />
    </Suspense>
  );
}
