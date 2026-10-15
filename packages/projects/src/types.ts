export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  type: "INTERIOR" | "EXTERIOR" | "MIXED";
  status: "ACTIVE" | "ARCHIVED";
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  assetCount: number;
  renderJobCount: number;
}

export interface ProjectListResult {
  items: ProjectSummary[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}
