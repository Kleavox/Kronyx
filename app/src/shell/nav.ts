import {
  Activity,
  Boxes,
  History,
  Server,
  Siren,
  type LucideIcon,
} from "lucide-react";

interface Section {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

export const SECTIONS: Section[] = [
  { to: "/", label: "Fleet", icon: Server, end: true },
  { to: "/services", label: "Services", icon: Boxes },
  { to: "/checks", label: "Checks", icon: Activity },
  { to: "/incidents", label: "Incidents", icon: Siren },
  { to: "/history", label: "History", icon: History },
];
