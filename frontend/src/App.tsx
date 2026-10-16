import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { AppLayout } from './components/AppLayout'
import { ProtectedRoute } from './components/ProtectedRoute'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
import { lazy, Suspense } from 'react'
import { ArticleEditorPage } from './pages/ArticleEditorPage'
import { ArticlePage } from './pages/ArticlePage'
import { ArticlesManagePage } from './pages/ArticlesManagePage'
import { HelpCenterPage } from './pages/HelpCenterPage'
import { NewTicketPage } from './pages/NewTicketPage'
import { TicketDetailPage } from './pages/TicketDetailPage'
import { TicketsPage } from './pages/TicketsPage'
import { AssetDetailPage } from './pages/inventory/AssetDetailPage'
import { AssetsPage } from './pages/inventory/AssetsPage'
import { InventoryOverviewPage } from './pages/inventory/InventoryOverviewPage'
import { MovementsPage } from './pages/inventory/MovementsPage'
import { OrganizationPage } from './pages/inventory/OrganizationPage'
import { ProductDetailPage } from './pages/inventory/ProductDetailPage'
import { ProductsPage } from './pages/inventory/ProductsPage'

const ManagerPage = lazy(() => import('./pages/ManagerPage').then(module => ({ default: module.ManagerPage })))

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/manager" element={<Suspense fallback={<div role="status" className="card card--empty">Carregando visão gerencial...</div>}><ManagerPage /></Suspense>} />
            <Route path="/tickets" element={<TicketsPage />} />
            <Route path="/tickets/new" element={<NewTicketPage />} />
            <Route path="/tickets/:id" element={<TicketDetailPage />} />
            <Route path="/help" element={<HelpCenterPage />} />
            <Route path="/help/manage" element={<ArticlesManagePage />} />
            <Route path="/help/manage/new" element={<ArticleEditorPage key="new" />} />
            <Route path="/help/manage/:id" element={<ArticleEditorPage key="edit" />} />
            <Route path="/help/:id" element={<ArticlePage />} />
            <Route path="/inventory" element={<InventoryOverviewPage />} />
            <Route path="/inventory/products" element={<ProductsPage />} />
            <Route path="/inventory/products/:id" element={<ProductDetailPage />} />
            <Route path="/inventory/assets" element={<AssetsPage />} />
            <Route path="/inventory/assets/:id" element={<AssetDetailPage />} />
            <Route path="/inventory/movements" element={<MovementsPage />} />
            <Route path="/inventory/organization" element={<OrganizationPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
