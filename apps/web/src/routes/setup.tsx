import { createFileRoute } from '@tanstack/react-router';

// M8b-T11: the first-run setup screen replaces this placeholder.
export const Route = createFileRoute('/setup')({
  component: SetupPlaceholder,
});

function SetupPlaceholder() {
  return <main />;
}
