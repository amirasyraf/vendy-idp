import { PropsWithChildren, useEffect } from 'react';
import { Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useTaskEventStream } from '@backstage/plugin-scaffolder-react';

const vmTemplates = new Set(['vm-request', 'vm-modify', 'container-request']);

function completedRunPath(output: Record<string, unknown> | undefined) {
  if (!output) return undefined;
  // Only navigate to our run route, never an arbitrary template-provided URL.
  if (Array.isArray(output.links)) {
    for (const link of output.links) {
      if (typeof link?.url !== 'string') continue;
      try {
        const url = new URL(link.url, window.location.origin);
        if (url.origin !== window.location.origin) continue;
        if (/^\/(vms|containers)\/runs\/[1-9]\d*$/.test(url.pathname))
          return url.pathname;
      } catch {
        // Non-URL outputs (e.g. catalog entity refs) aren't run destinations.
      }
    }
  }
  if (Number.isSafeInteger(output.runId) && (output.runId as number) > 0)
    return `/vms/runs/${output.runId}`;
  return undefined;
}

function RedirectCompletedVmTask() {
  const { taskId } = useParams();
  const stream = useTaskEventStream(taskId!);
  const navigate = useNavigate();
  const templateRef = stream.task?.spec.templateInfo?.entityRef ?? '';
  const template = templateRef.split('/').pop()!;
  const path = completedRunPath(stream.output);
  useEffect(() => {
    if (
      stream.task?.id !== taskId ||
      !vmTemplates.has(template) ||
      !stream.completed ||
      stream.cancelled ||
      stream.error ||
      !path
    )
      return;
    if (stream.task?.status === 'failed' || stream.task?.status === 'cancelled')
      return;
    if (
      Object.values(stream.steps).some(step =>
        ['failed', 'cancelled'].includes(step.status),
      )
    )
      return;
    navigate(path, { replace: true });
  }, [
    navigate,
    path,
    template,
    taskId,
    stream.completed,
    stream.cancelled,
    stream.error,
    stream.task,
    stream.steps,
  ]);
  return null;
}

/** Keep stock task controls/errors/output; only successful VM tasks hand off. */
export function VmTaskRedirect({ children }: PropsWithChildren<{}>) {
  return (
    <>
      <Routes>
        <Route path=":taskId" element={<RedirectCompletedVmTask />} />
        <Route path="*" element={null} />
      </Routes>
      {children}
    </>
  );
}
