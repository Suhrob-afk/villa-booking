/**
 * The Dashboard: Overview and Commissions under one header.
 *
 * Overview is owner-only. A makler has no villas to report on and never had an
 * owner view, so they land straight on the commission list they already had --
 * no tab strip, nothing new to learn.
 */

import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { useBackButton } from '../lib/useBackButton'
import { TopBar } from '../components/ui'
import CommissionsTab from './Commissions'
import Overview from './Overview'

type Tab = 'overview' | 'commissions'

export default function Dashboard() {
  const { user } = useAuth()
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('overview')

  useBackButton(null)

  if (!user) return null

  const isOwner = user.is_owner
  const active: Tab = isOwner ? tab : 'commissions'

  return (
    <>
      <TopBar title={t('dashboard.title')} />
      <main className="screen">
        {isOwner && (
          <div className="segmented" role="tablist" style={{ marginBottom: 14 }}>
            <button
              type="button"
              className={`segmented-item${active === 'overview' ? ' segmented-item-active' : ''}`}
              onClick={() => setTab('overview')}
            >
              {t('dashboard.tabOverview')}
            </button>
            <button
              type="button"
              className={`segmented-item${active === 'commissions' ? ' segmented-item-active' : ''}`}
              onClick={() => setTab('commissions')}
            >
              {t('dashboard.tabCommissions')}
            </button>
          </div>
        )}

        {active === 'overview' ? <Overview /> : <CommissionsTab />}
      </main>
    </>
  )
}
