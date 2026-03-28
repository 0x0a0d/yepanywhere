import { useShells } from "../hooks/useShells";
import { SidebarIcons, SidebarNavItem } from "./SidebarNavItem";

interface ShellsNavItemProps {
  onClick?: () => void;
  basePath?: string;
}

export function ShellsNavItem({ onClick, basePath }: ShellsNavItemProps) {
  const { shells } = useShells();

  return (
    <SidebarNavItem
      to="/shells"
      icon={SidebarIcons.shells}
      label="Shells"
      onClick={onClick}
      hasActivityIndicator={shells.some((shell) => shell.state === "running")}
      basePath={basePath}
    />
  );
}
