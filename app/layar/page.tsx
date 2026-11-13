import { ProjectorBoard } from '@/components/ProjectorBoard';

export default async function LayarPage({
  searchParams,
}: {
  searchParams: Promise<{ kode?: string }>;
}) {
  const params = await searchParams;
  return <ProjectorBoard initialCode={params.kode} />;
}
