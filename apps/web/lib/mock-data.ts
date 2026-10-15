import type { LucideIcon } from "lucide-react";
import {
  Boxes,
  BriefcaseBusiness,
  Clock3,
  Cpu,
  FolderKanban,
  Gauge,
  Image as ImageIcon,
  Library,
  Settings,
  Video,
} from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon };

export const navigation: NavItem[] = [
  { href: "/", label: "Tổng quan", icon: Gauge },
  { href: "/image-studio", label: "AI Image Studio", icon: ImageIcon },
  { href: "/video-studio", label: "AI Video Studio", icon: Video },
  { href: "/workflow-studio", label: "Workflow Studio", icon: Boxes },
  { href: "/projects", label: "Dự án của tôi", icon: FolderKanban },
  { href: "/jobs", label: "Lịch sử xử lý", icon: Clock3 },
  { href: "/gpu", label: "Quản lý GPU", icon: Cpu },
  { href: "/assets", label: "Thư viện tài nguyên", icon: Library },
  { href: "/settings", label: "Cài đặt", icon: Settings },
];

export const archImages = [
  "/architecture/villa-dusk.svg",
  "/architecture/interior-warm.svg",
  "/architecture/tropical-house.svg",
  "/architecture/office-minimal.svg",
  "/architecture/villa-clay.svg",
  "/architecture/courtyard-night.svg",
] as const;

export const projects = [
  { id: "PRJ-024", name: "Biệt thự ven hồ", type: "Ngoại thất", image: archImages[0], images: 18, videos: 3, updated: "12 phút trước" },
  { id: "PRJ-023", name: "Căn hộ Lumière", type: "Nội thất", image: archImages[1], images: 12, videos: 1, updated: "Hôm qua" },
  { id: "PRJ-021", name: "Tropical Residence", type: "Ngoại thất", image: archImages[2], images: 27, videos: 4, updated: "12/10/2026" },
  { id: "PRJ-018", name: "Văn phòng Horizon", type: "Nội thất", image: archImages[3], images: 9, videos: 0, updated: "08/10/2026" },
] as const;

export const jobs = [
  { id: "JOB-A91F", project: "Biệt thự ven hồ", type: "Ảnh", workflow: "ArchViz Ultra V3", gpu: "RTX 4090", resolution: "4K", status: "Completed", duration: "03:42", cost: "$0.031", created: "01:24 hôm nay" },
  { id: "JOB-A91E", project: "Căn hộ Lumière", type: "Video", workflow: "Wan 2.2 I2V", gpu: "RTX 4090", resolution: "720p", status: "Running", duration: "02:18", cost: "$0.058 ước tính", created: "01:17 hôm nay" },
  { id: "JOB-A91D", project: "Tropical Residence", type: "Ảnh", workflow: "Canny + Depth", gpu: "RTX 3090", resolution: "2K", status: "Failed", duration: "00:38", cost: "$0.004", created: "Hôm qua" },
  { id: "JOB-A91C", project: "Văn phòng Horizon", type: "Ảnh", workflow: "Architecture Canny", gpu: "RTX 4090", resolution: "4K", status: "Queued", duration: "—", cost: "$0.028 ước tính", created: "Hôm qua" },
] as const;

export const assets = [
  { name: "villa_final_4k.webp", type: "Generated Image", image: archImages[0], size: "8.4 MB", dimensions: "3840 × 2160" },
  { name: "living_room_source.jpg", type: "Source Render", image: archImages[1], size: "4.2 MB", dimensions: "2560 × 1440" },
  { name: "tropical_evening.webp", type: "Generated Image", image: archImages[2], size: "7.8 MB", dimensions: "3840 × 2160" },
  { name: "office_warm.webp", type: "Generated Image", image: archImages[3], size: "6.1 MB", dimensions: "2560 × 1440" },
  { name: "facade_depth.png", type: "Depth Map", image: archImages[4], size: "3.3 MB", dimensions: "1920 × 1080" },
  { name: "villa_orbit_01.mp4", type: "Generated Video", image: archImages[5], size: "46.7 MB", dimensions: "1280 × 720" },
] as const;

export const quickTools = [
  { label: "Mở ComfyUI", icon: Cpu },
  { label: "Workflow mặc định", icon: BriefcaseBusiness },
  { label: "Tài liệu hướng dẫn", icon: Library },
] as const;
