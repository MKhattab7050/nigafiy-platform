// The design system's primitives. Import from '@/components/ui'; the files are split by role.
export { type ConnState, TONE, type Tone, severityTone, stateTone, statusColor, statusTone } from './tones';
export { Badge, ConfidenceBadge, Dot, InferredBadge, StateBadge, StatusBadge, SuggestedBadge, Tag, ToneIcon, useStatusLabel } from './status';
export { Card, PageHeader, SectionLabel } from './layout';
export { BUTTON_BASE, BUTTON_SIZE, BUTTON_VARIANT, Button, FIELD, Field, Input, Segmented, Select, Switch, Tabs, Textarea } from './controls';
export { Async, EmptyState, ErrorNote, Notice, Skeleton, SkeletonBlock, Spinner } from './feedback';
export { Drawer, Modal, Tooltip } from './overlay';
export { type ConfirmOptions, ConfirmProvider, useConfirm } from './confirm';
export { CopyBlock, DataTable, Evidence, Fact } from './data';
