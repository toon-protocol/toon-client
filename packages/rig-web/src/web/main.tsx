import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RigConfigProvider } from '@/hooks/use-rig-config';
import { ProfileCacheProvider } from '@/hooks/use-profile-cache';
import { AppLayout } from '@/app/app-layout';
import { RepoLayout } from '@/app/repo-layout';
import { RepoListPage } from '@/app/pages/repo-list-page';
import { RepoHomePage } from '@/app/pages/repo-home-page';
import { TreePage } from '@/app/pages/tree-page';
import { BlobPage } from '@/app/pages/blob-page';
import { CommitLogPage } from '@/app/pages/commit-log-page';
import { CommitDetailPage } from '@/app/pages/commit-detail-page';
import { BlamePage } from '@/app/pages/blame-page';
import { IssueListPage } from '@/app/pages/issue-list-page';
import { IssueDetailPage } from '@/app/pages/issue-detail-page';
import { PRListPage } from '@/app/pages/pr-list-page';
import { PRDetailPage } from '@/app/pages/pr-detail-page';
import './globals.css';

const root = document.getElementById('app');
if (!root) throw new Error('Root element #app not found');

createRoot(root).render(
  <StrictMode>
    <HashRouter>
      <TooltipProvider>
        <RigConfigProvider>
          <ProfileCacheProvider>
            <Routes>
              <Route element={<AppLayout />}>
                <Route index element={<RepoListPage />} />
                <Route path=":owner/:repo" element={<RepoLayout />}>
                  <Route index element={<RepoHomePage />} />
                  <Route path="tree/:ref/*" element={<TreePage />} />
                  <Route path="blob/:ref/*" element={<BlobPage />} />
                  <Route path="commits/:ref" element={<CommitLogPage />} />
                  <Route path="commit/:sha" element={<CommitDetailPage />} />
                  <Route path="blame/:ref/*" element={<BlamePage />} />
                  <Route path="issues" element={<IssueListPage />} />
                  <Route path="issues/:id" element={<IssueDetailPage />} />
                  <Route path="pulls" element={<PRListPage />} />
                  <Route path="pulls/:id" element={<PRDetailPage />} />
                </Route>
              </Route>
            </Routes>
          </ProfileCacheProvider>
        </RigConfigProvider>
      </TooltipProvider>
    </HashRouter>
  </StrictMode>,
);
