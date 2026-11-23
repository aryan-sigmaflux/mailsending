import { Suspense } from "react";
import { Skeleton } from "@/components/ui";
import CampaignAnalytics from "./CampaignAnalytics";

export default function Page() {
  return (
    <Suspense fallback={<Skeleton h={500} />}>
      <CampaignAnalytics />
    </Suspense>
  );
}
