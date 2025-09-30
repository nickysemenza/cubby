"use client";

import { useTRPC } from "~/trpc/react";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Plus } from "lucide-react";

// Hook to manage active project in localStorage
function useActiveProject() {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  useEffect(() => {
    // Get from localStorage on mount
    const stored = localStorage.getItem("activeProjectId");
    setActiveProjectId(stored);
  }, []);

  const setActiveProject = (projectId: string) => {
    localStorage.setItem("activeProjectId", projectId);
    setActiveProjectId(projectId);
  };

  return { activeProjectId, setActiveProject };
}

export function ProjectSwitcher() {
  const router = useRouter();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const { activeProjectId, setActiveProject } = useActiveProject();

  const { data: projects, isLoading } = useQuery(
    api.project.list.queryOptions(),
  );

  const validateAccess = useMutation(
    api.project.validateAccess.mutationOptions({
      onSuccess: () => {
        // Invalidate all queries to refetch with new project context
        void queryClient.invalidateQueries();
        router.refresh();
      },
      onError: (error: unknown) => {
        console.error("Failed to switch project:", error);
        // Could show a toast error here
      },
    }),
  );

  const handleProjectChange = async (projectId: string) => {
    if (projectId === "create-new") {
      // Handle new project creation
      router.push("/projects/new");
      return;
    }

    try {
      // Validate access first
      await validateAccess.mutateAsync({ projectId });

      // Set in localStorage
      setActiveProject(projectId);
    } catch {
      // Error is already logged in onError
    }
  };

  if (isLoading) {
    return <div className="bg-muted h-10 w-[200px] animate-pulse rounded-md" />;
  }

  if (!projects) return null;

  const activeProject = projects?.find((p) => p.id === activeProjectId);

  return (
    <div className="flex items-center gap-2">
      <Select
        value={activeProjectId || ""}
        onValueChange={handleProjectChange}
        disabled={validateAccess.isPending}
      >
        <SelectTrigger className="w-[200px]">
          <SelectValue placeholder="Select project">
            {activeProject ? activeProject.name : "Select project"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              <div className="flex flex-col">
                <span>{project.name}</span>
                {project._count && (
                  <span className="text-muted-foreground text-xs">
                    {project._count.members} member
                    {project._count.members !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
            </SelectItem>
          ))}
          <SelectItem value="create-new">
            <div className="flex items-center gap-2">
              <Plus className="h-4 w-4" />
              <span>Create new project</span>
            </div>
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export function ProjectSwitcherSkeleton() {
  return <div className="bg-muted h-10 w-[200px] animate-pulse rounded-md" />;
}
