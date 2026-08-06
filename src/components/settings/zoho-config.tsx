'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Building2, CheckCircle2, Trash2, Plus, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';
import { useTranslations } from 'next-intl';
import type { ZohoDataCenter, ZohoLeadRuleCriteriaType, ZohoLeadRuleMatchType } from '@/lib/zoho/types';

const MASKED = '••••••••••••••••';

const DATA_CENTER_LABEL: Record<ZohoDataCenter, string> = {
  in: 'India (zoho.in)',
  com: 'United States (zoho.com)',
  eu: 'Europe (zoho.eu)',
  'com.au': 'Australia (zoho.com.au)',
  jp: 'Japan (zoho.jp)',
  ca: 'Canada (zohocloud.ca)',
  'com.cn': 'China (zoho.com.cn)',
};

const CRITERIA_LABEL: Record<ZohoLeadRuleCriteriaType, string> = {
  message_text: 'Message text',
  contact_city: 'Contact city',
};

interface RuleRow {
  id: string;
  name: string;
  criteria_type: ZohoLeadRuleCriteriaType;
  match_type: ZohoLeadRuleMatchType;
  case_sensitive: boolean;
  keywords: string[];
  lead_source: string | null;
  is_active: boolean;
}

const EMPTY_DRAFT = {
  name: '',
  criteria_type: 'message_text' as ZohoLeadRuleCriteriaType,
  match_type: 'contains' as ZohoLeadRuleMatchType,
  case_sensitive: false,
  keywords: '',
  lead_source: '',
};

export function ZohoConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.zoho');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [dataCenter, setDataCenter] = useState<ZohoDataCenter>('in');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [clientSecretEdited, setClientSecretEdited] = useState(false);
  const [refreshToken, setRefreshToken] = useState('');
  const [refreshTokenEdited, setRefreshTokenEdited] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [lastOrgName, setLastOrgName] = useState<string | null>(null);

  const [rules, setRules] = useState<RuleRow[]>([]);
  const [rulesLoading, setRulesLoading] = useState(true);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [addingRule, setAddingRule] = useState(false);

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/zoho/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setDataCenter(data.data_center);
        setClientId(data.client_id ?? '');
        setClientSecret(data.has_client_secret ? MASKED : '');
        setClientSecretEdited(false);
        setRefreshToken(data.has_refresh_token ? MASKED : '');
        setRefreshTokenEdited(false);
        setIsActive(Boolean(data.is_active));
        setLastOrgName(data.last_org_name ?? null);
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const fetchRules = useCallback(async () => {
    setRulesLoading(true);
    try {
      const res = await fetch('/api/zoho/rules');
      const data = await res.json();
      if (res.ok) setRules(data.rules ?? []);
    } catch {
      toast.error(t('rulesLoadFailed'));
    } finally {
      setRulesLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
    void fetchRules();
  }, [accountId, fetchConfig, fetchRules]);

  const secretPayload = () => (clientSecretEdited ? clientSecret.trim() : undefined);
  const refreshTokenPayload = () => (refreshTokenEdited ? refreshToken.trim() : undefined);

  const buildConnectionBody = () => ({
    data_center: dataCenter,
    client_id: clientId.trim(),
    client_secret: secretPayload(),
    refresh_token: refreshTokenPayload(),
    is_active: isActive,
  });

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/zoho/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildConnectionBody()),
      });
      const data = await res.json();
      if (res.ok) toast.success(t('testSuccess', { org: data.company_name }));
      else toast.error(data.error ?? t('testFailed'));
    } catch {
      toast.error(t('testNetworkError'));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!clientId.trim()) {
      toast.error(t('missingClientId'));
      return;
    }
    if (!configured && !clientSecretEdited) {
      toast.error(t('missingClientSecret'));
      return;
    }
    if (!configured && !refreshTokenEdited) {
      toast.error(t('missingRefreshToken'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/zoho/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildConnectionBody()),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        await fetchConfig();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!confirm(t('removeConfirm'))) return;
    setRemoving(true);
    try {
      const res = await fetch('/api/zoho/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setConfigured(false);
        setClientId('');
        setClientSecret('');
        setClientSecretEdited(false);
        setRefreshToken('');
        setRefreshTokenEdited(false);
        setIsActive(false);
        setLastOrgName(null);
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  const handleAddRule = async () => {
    const keywords = draft.keywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (!draft.name.trim()) {
      toast.error(t('ruleNameRequired'));
      return;
    }
    if (keywords.length === 0) {
      toast.error(t('ruleKeywordsRequired'));
      return;
    }
    setAddingRule(true);
    try {
      const res = await fetch('/api/zoho/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name.trim(),
          criteria_type: draft.criteria_type,
          match_type: draft.match_type,
          case_sensitive: draft.case_sensitive,
          keywords,
          lead_source: draft.lead_source.trim() || null,
          is_active: true,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('ruleAdded'));
        setDraft(EMPTY_DRAFT);
        await fetchRules();
      } else {
        toast.error(data.error ?? t('ruleAddFailed'));
      }
    } catch {
      toast.error(t('ruleAddFailed'));
    } finally {
      setAddingRule(false);
    }
  };

  const handleToggleRule = async (rule: RuleRow, active: boolean) => {
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, is_active: active } : r)));
    const res = await fetch(`/api/zoho/rules/${rule.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...rule, is_active: active }),
    });
    if (!res.ok) {
      setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, is_active: !active } : r)));
      toast.error(t('ruleUpdateFailed'));
    }
  };

  const handleDeleteRule = async (rule: RuleRow) => {
    if (!confirm(t('ruleDeleteConfirm', { name: rule.name }))) return;
    const res = await fetch(`/api/zoho/rules/${rule.id}`, { method: 'DELETE' });
    if (res.ok) {
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
      toast.success(t('ruleDeleted'));
    } else {
      toast.error(t('ruleDeleteFailed'));
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
      </div>
    );
  }

  const disabled = !canEdit || saving;

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnlyConfig')}
        </p>
      )}

      <div className="space-y-6">
        {configured && lastOrgName && (
          <Alert className="bg-card border-border">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-primary" />
              <AlertTitle className="text-foreground mb-0">
                {t('connectedAs', { org: lastOrgName })}
              </AlertTitle>
            </div>
            <AlertDescription className="text-muted-foreground">
              {t('connectedDesc')}
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4 text-primary" /> {t('connectionTitle')}
            </CardTitle>
            <CardDescription>{t('encryptionNotice')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t('dataCenter')}</Label>
                <Select
                  value={dataCenter}
                  onValueChange={(v) => setDataCenter(v as ZohoDataCenter)}
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(DATA_CENTER_LABEL).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="zoho-client-id">{t('clientId')}</Label>
                <Input
                  id="zoho-client-id"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="1000.XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                  disabled={disabled}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="zoho-client-secret">{t('clientSecret')}</Label>
                <div className="relative">
                  <Input
                    id="zoho-client-secret"
                    type={showSecrets ? 'text' : 'password'}
                    value={clientSecret}
                    onChange={(e) => {
                      setClientSecret(e.target.value);
                      setClientSecretEdited(true);
                    }}
                    onFocus={() => {
                      if (clientSecret === MASKED) {
                        setClientSecret('');
                        setClientSecretEdited(true);
                      }
                    }}
                    disabled={disabled}
                    className="pr-10"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="zoho-refresh-token">{t('refreshToken')}</Label>
                <div className="relative">
                  <Input
                    id="zoho-refresh-token"
                    type={showSecrets ? 'text' : 'password'}
                    value={refreshToken}
                    onChange={(e) => {
                      setRefreshToken(e.target.value);
                      setRefreshTokenEdited(true);
                    }}
                    onFocus={() => {
                      if (refreshToken === MASKED) {
                        setRefreshToken('');
                        setRefreshTokenEdited(true);
                      }
                    }}
                    disabled={disabled}
                    className="pr-10"
                  />
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowSecrets(!showSecrets)}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {showSecrets ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              {showSecrets ? t('hideSecrets') : t('showSecrets')}
            </button>

            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('enableSync')}</p>
                <p className="text-xs text-muted-foreground">{t('enableSyncDesc')}</p>
              </div>
              <Switch checked={isActive} onCheckedChange={setIsActive} disabled={disabled} />
            </div>

            <div className="flex flex-wrap gap-3 pt-2">
              <Button onClick={handleSave} disabled={disabled}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('save')}
              </Button>
              <Button variant="outline" onClick={handleTest} disabled={testing || disabled}>
                {testing ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('testConnection')}
              </Button>
              {configured && (
                <Button
                  variant="outline"
                  onClick={handleRemove}
                  disabled={removing || !canEdit}
                  className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
                >
                  {removing ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  {t('disconnect')}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('rulesTitle')}</CardTitle>
            <CardDescription>{t('rulesDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {rulesLoading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
              </div>
            ) : rules.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noRules')}</p>
            ) : (
              <div className="space-y-2">
                {rules.map((rule) => (
                  <div
                    key={rule.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-foreground">{rule.name}</p>
                        <Badge variant="outline">{CRITERIA_LABEL[rule.criteria_type]}</Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {rule.match_type === 'exact' ? t('matchExact') : t('matchContains')}:{' '}
                        {rule.keywords.join(', ')}
                      </p>
                      {rule.criteria_type === 'contact_city' && (
                        <p className="text-xs text-amber-500">{t('contactCityNote')}</p>
                      )}
                    </div>
                    <Switch
                      checked={rule.is_active}
                      onCheckedChange={(v) => handleToggleRule(rule, v)}
                      disabled={!canEdit}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => handleDeleteRule(rule)}
                      disabled={!canEdit}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {canEdit && (
              <div className="space-y-3 rounded-md border border-dashed border-border p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>{t('ruleName')}</Label>
                    <Input
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      placeholder={t('ruleNamePlaceholder')}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('ruleCriteria')}</Label>
                    <Select
                      value={draft.criteria_type}
                      onValueChange={(v) =>
                        setDraft({ ...draft, criteria_type: v as ZohoLeadRuleCriteriaType })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="message_text">{CRITERIA_LABEL.message_text}</SelectItem>
                        <SelectItem value="contact_city">{CRITERIA_LABEL.contact_city}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>{t('ruleMatchType')}</Label>
                    <Select
                      value={draft.match_type}
                      onValueChange={(v) => setDraft({ ...draft, match_type: v as ZohoLeadRuleMatchType })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="contains">{t('matchContains')}</SelectItem>
                        <SelectItem value="exact">{t('matchExact')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('ruleKeywords')}</Label>
                    <Input
                      value={draft.keywords}
                      onChange={(e) => setDraft({ ...draft, keywords: e.target.value })}
                      placeholder={t('ruleKeywordsPlaceholder')}
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-[1fr_auto] items-end">
                  <div className="space-y-1.5">
                    <Label>{t('ruleLeadSource')}</Label>
                    <Input
                      value={draft.lead_source}
                      onChange={(e) => setDraft({ ...draft, lead_source: e.target.value })}
                      placeholder={t('ruleLeadSourcePlaceholder')}
                    />
                  </div>
                  <Button onClick={handleAddRule} disabled={addingRule}>
                    {addingRule ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    {t('addRule')}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
