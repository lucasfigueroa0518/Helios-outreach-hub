import type { ReactNode } from 'react';

import { HubNav } from '@/app/hub/hub-nav';

export default function HubLayout({ children }: { children: ReactNode }) {
  return (
    <div className="hub-shell">
      <HubNav />
      {children}
    </div>
  );
}
