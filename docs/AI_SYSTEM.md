# FlowVision AI Assistant System

**Purpose:** Build an intelligent assistant that acts as a secretary, analyst, and organizational professional—automatically aware of your organization's structure, documents, routes, and activity without manual updates.

---

## 1. System Overview

### Current Architecture
- **Frontend:** Nuxt 4 + Vue 3 + Tailwind CSS + Pinia
- **Backend:** Nitro API + Sequelize ORM + MySQL/MariaDB
- **Database:** 17 tables covering users, documents, routes, offices, liaisons, approvals, and activity logs
- **Existing AI Infrastructure:** `server/lib/ai.ts`, `server/lib/knowledge.ts` for document classification

### What the AI Assistant Does
The AI acts as a **dynamic organizational intelligence system** that:
- ✅ Answers questions about your organization structure, offices, and personnel
- ✅ Queries live data from the database in real-time
- ✅ Analyzes document workflows and approval statuses
- ✅ Provides insights on organization activity and routing patterns
- ✅ Helps with document classification and routing recommendations
- ✅ Learns from your knowledge files (PDFs, Word docs, CSVs, markdown)
- ✅ **Automatically stays updated** — no manual retraining needed (queries live data)

---

## 2. Key AI Features

### 2.1 Conversation Interface
- **New Page:** `/ai/chat` (or `/assistant`)
- **Vue Component:** `app/pages/ai/chat.vue`
- **Features:**
  - Chat-like conversation with the AI
  - Real-time responses
  - Context awareness (current user's organization, role, office)
  - Message history per session
  - Export conversation as PDF/markdown

### 2.2 Dynamic Knowledge Base
The AI automatically has access to:

#### A. Organization Data (Queried in real-time)
- Office structure and codes
- Personnel and their roles/assignments
- Document types and routes
- Active workflows and approvals
- Activity logs and metrics
- Liaison assignments and availability
- Route steps and final checkpoints

#### B. Knowledge Files (Uploaded by CLIENT)
- PDFs, Word documents, markdown files
- CSV data
- Text knowledge bases
- Embedded in prompts when relevant

#### C. Document Context
- Recently created/updated documents
- Approval statuses and history
- Document routes and progress
- Classification and categorization

### 2.3 AI Capabilities

**Query Types the AI can handle:**

1. **Organization Intelligence**
   - "How many documents were processed this week?"
   - "Which office has the most pending approvals?"
   - "Show me the document flow from Records Section to the Mayor's office"
   - "What are our active document routes?"

2. **Personnel & Resources**
   - "Who is available to be a messenger today?"
   - "Which employees work in HR?"
   - "Show me liaison assignments and their current status"

3. **Document Analysis**
   - "Summarize recent documents about budget"
   - "Which document type is most common?"
   - "Recommend a route for a leave request document"

4. **Workflow Insights**
   - "What's the average processing time for documents?"
   - "Show me documents stuck at the mayor's office"
   - "Which step has the longest delays?"

5. **Help & Guidance**
   - "How do I submit a document?"
   - "What's the status of document BAG-ADM-RECORDS-48213907?"
   - "Who approves personnel decisions?"

---

## 3. Technical Architecture

### 3.1 Component Structure

```
app/pages/ai/
├── chat.vue                 # Main chat interface
├── components/
│   ├── ChatMessage.vue      # Message display
│   ├── ChatInput.vue        # Input field with suggestions
│   └── ContextPanel.vue     # Show active context (org, role, office)

server/api/ai/
├── chat.post.ts             # POST /api/ai/chat — process messages
├── context.get.ts           # GET /api/ai/context — get active context
└── history.get.ts           # GET /api/ai/history — chat history

server/lib/
├── ai.ts                    # AI service (existing, extend it)
├── knowledge.ts             # Knowledge retrieval (existing)
├── ai-context.ts            # NEW: Extract live org data
├── ai-prompts.ts            # NEW: System prompts and context building
└── ai-tools.ts              # NEW: Tool definitions for AI function calling
```

### 3.2 Data Flow

```
User Message
    ↓
[ChatInput.vue] → POST /api/ai/chat
    ↓
[chat.post.ts - Request Handler]
    ↓
[Authenticate User & Load Context]
    ├─ User org_id, role, office_id
    ├─ Current permissions
    └─ Organization metadata
    ↓
[Build AI System Prompt] (ai-prompts.ts)
    ├─ Organization structure (offices, personnel)
    ├─ Active routes and workflows
    ├─ Relevant knowledge files
    └─ User role & office context
    ↓
[User Query + Context + Tools] → AI Model (Groq/Claude/OpenAI)
    ↓
[AI decides to use Tools or Direct Response]
    ├─ If needs data → Call Tool
    └─ If can answer → Return response
    ↓
[Tool Execution] (if needed) — run queries via ai-tools.ts
    ├─ Query database via Sequelize models
    ├─ Filter by org_id and user permissions
    └─ Format results
    ↓
[AI processes Tool Results]
    ↓
[Stream/Return Response] → ChatMessage.vue
    ↓
[Display in Chat UI]
```

### 3.3 System Prompt Strategy

The AI operates with **dynamic context** — each message includes:

```typescript
// Simplified example
const systemPrompt = `
You are an organizational intelligence assistant for ${org.name}.

# Organization Structure
Offices: ${offices.map(o => o.name + ' (' + o.code + ')').join(', ')}
Key Personnel: ${personnel.slice(0, 10).map(p => p.name + ' (' + p.role + ')').join(', ')}
Active Routes: ${routes.length} document routes in use

# Your Capabilities
- Query real-time data about documents, workflows, and personnel
- Access knowledge files uploaded to your organization
- Provide insights on processing times and bottlenecks
- Recommend routing based on document type and current queue

# User Context
You are speaking with: ${user.name} (${user.role}) at ${office.name}
You can only see data this person has access to.

# Tools Available
You can use these functions to retrieve current data:
- queryDocuments() - Get documents by status, type, office, date range
- queryApprovals() - Get pending approvals
- queryPersonnel() - Get employees by office or role
- queryRoutes() - Get document routes and their steps
- queryActivity() - Get activity metrics
- queryKnowledge() - Search organization knowledge files

Always retrieve current data before answering questions about status, counts, or availability.
`;
```

---

## 4. Core Server Utilities

### 4.1 `server/lib/ai-context.ts` — Extract Live Org Data

```typescript
// Retrieves organization context without manual updates
export async function getOrganizationContext(orgId: number, userId: number) {
  return {
    organization: await Organization.findByPk(orgId),
    offices: await Office.findAll({ where: { org_id: orgId } }),
    personnel: await User.findAll({ where: { org_id: orgId } }),
    routes: await Route.findAll({ where: { org_id: orgId } }),
    documentTypes: await DocumentType.findAll({ where: { org_id: orgId } }),
    knowledgeFiles: await KnowledgeFile.findAll({ where: { org_id: orgId } }),
    stats: {
      pendingDocuments: await Document.count({ 
        where: { org_id: orgId, status: ['PENDING', 'IN_TRANSIT'] }
      }),
      recentActivity: await Activity.findAll({ 
        where: { org_id: orgId },
        order: [['created_at', 'DESC']],
        limit: 20
      })
    }
  };
}
```

### 4.2 `server/lib/ai-prompts.ts` — Build Dynamic Prompts

```typescript
// Builds context-aware prompts for the AI
export function buildSystemPrompt(org, userContext, recentData) {
  // 1. Organization structure
  // 2. User role and permissions
  // 3. Current status/metrics
  // 4. Knowledge base summary
  // 5. Available tools
  // 6. Response guidelines
}

export function buildUserContext(user, office) {
  // Format user's role, permissions, and location for the AI
}
```

### 4.3 `server/lib/ai-tools.ts` — Define Tool Functions

```typescript
// Tools the AI can call to query data
export const aiTools = [
  {
    name: 'queryDocuments',
    description: 'Search documents by type, status, date, office',
    parameters: { /* define query filters */ }
  },
  {
    name: 'queryApprovals',
    description: 'Get pending approvals for the current office',
    parameters: { /* filter options */ }
  },
  {
    name: 'queryPersonnel',
    description: 'Search employees by office or role',
    parameters: { /* search filters */ }
  },
  {
    name: 'queryRoutes',
    description: 'Get document routes and their steps',
    parameters: { /* route filters */ }
  },
  {
    name: 'queryActivity',
    description: 'Get organization activity metrics and trends',
    parameters: { /* time range, office, type */ }
  },
  {
    name: 'searchKnowledge',
    description: 'Search uploaded knowledge files',
    parameters: { query: string, limit: number }
  }
];

// Executor function
export async function executeTool(toolName, params, orgId, userId) {
  // Route to appropriate query function
  // Apply permission checks
  // Return formatted results
}
```

### 4.4 `server/api/ai/chat.post.ts` — Main Chat Endpoint

```typescript
export default defineEventHandler(async (event) => {
  const user = await requireAuth(event);
  const { message, conversationId } = await readBody(event);

  // 1. Load context
  const context = await getOrganizationContext(user.org_id, user.id);
  
  // 2. Build system prompt
  const systemPrompt = buildSystemPrompt(context, user);
  
  // 3. Get chat history (if continuing conversation)
  const history = conversationId 
    ? await ChatMessage.findAll({ where: { conversation_id: conversationId } })
    : [];

  // 4. Call AI with message, system prompt, and tools
  const response = await callAI(
    message,
    systemPrompt,
    history,
    aiTools,
    (toolName, params) => executeTool(toolName, params, user.org_id, user.id)
  );

  // 5. Save conversation
  await ChatMessage.create({
    conversation_id: conversationId,
    user_id: user.id,
    org_id: user.org_id,
    role: 'user',
    content: message
  });

  await ChatMessage.create({
    conversation_id: conversationId,
    org_id: user.org_id,
    role: 'assistant',
    content: response
  });

  return { message: response, conversationId };
});
```

---

## 5. Auto-Update Strategy (No Manual Retraining)

### Why It Works:
1. **Live Data Queries:** Every time a user asks a question, the AI queries the **current database state**
2. **No Caching:** Each conversation fetches fresh data from Sequelize models
3. **Role-Based Filtering:** Queries respect user permissions automatically
4. **Knowledge Files:** AI has access to latest uploaded files

### Example: Adding a New Feature

**Scenario:** You add a new `Document Attachment` field to documents.

**Without Manual AI Update:**
1. ✅ Database schema updated
2. ✅ Sequelize model updated
3. ✅ New query in `ai-tools.ts` executes: `Document.findAll()` now includes attachments
4. ✅ Next time user asks "show me document attachments" → AI can use the tool
5. ✅ **AI is automatically aware** of the new field

**No need to:**
- ❌ Retrain the AI model
- ❌ Update prompts manually
- ❌ Rebuild knowledge base
- ❌ Tell the AI about changes

---

## 6. Database Tables Used by AI

The AI queries these existing tables:

| Table | Purpose | AI Uses For |
|-------|---------|------------|
| `organizations` | Org metadata | Context about the organization |
| `users` | Personnel | Personnel queries, role-based filtering |
| `offices` | Office structure | Organization structure, routing |
| `document_types` | Doc categories | Classification, routing recommendations |
| `documents` | All documents | Document status, filtering, analysis |
| `routes` | Workflow definitions | Route details, step information |
| `route_steps` | Route details | Workflow structure, final checkpoints |
| `approvals` | Approval requests | Pending approvals, bottlenecks |
| `liaisons` | Messengers | Availability, assignment status |
| `knowledge_files` | Org knowledge | Business rules, context, guidance |
| `activity_logs` | Audit trail | Trends, metrics, analysis |

---

## 7. Implementation Roadmap

### Phase 1: Foundation (Week 1)
- [ ] Create `/api/ai/chat.post.ts` endpoint
- [ ] Create `server/lib/ai-context.ts` — extract org data
- [ ] Create `server/lib/ai-prompts.ts` — build dynamic prompts
- [ ] Create `server/lib/ai-tools.ts` — define query tools
- [ ] Set up AI model integration (Groq/Claude/OpenAI)

### Phase 2: UI (Week 1-2)
- [ ] Create `app/pages/ai/chat.vue` page
- [ ] Create chat components (message, input, context panel)
- [ ] Add message streaming/real-time display
- [ ] Add conversation history UI
- [ ] Add context awareness display

### Phase 3: Tools & Execution (Week 2)
- [ ] Implement tool executors for all tool types
- [ ] Add permission-based filtering
- [ ] Add knowledge file search
- [ ] Add query result formatting
- [ ] Test with various query types

### Phase 4: Polish & Deploy (Week 2-3)
- [ ] Add error handling
- [ ] Add rate limiting
- [ ] Add conversation export
- [ ] Add activity logging for AI queries
- [ ] Deploy and test with real users

---

## 8. Quick API Examples

### Example 1: Simple Question
```
User: "How many documents were submitted this week?"

Flow:
1. AI receives question + system prompt with org context
2. AI decides to use queryDocuments() tool
3. Tool executes: Document.count({ where: { org_id, created_at: > 7 days ago } })
4. AI returns: "42 documents were submitted this week"
```

### Example 2: Role-Based Query
```
User: "Show me documents waiting for my approval"

Flow:
1. System identifies user role = STAFF at Office of City Mayor
2. AI knows: Only documents at FINAL CHECKPOINT of routes can be approved there
3. AI uses queryApprovals() with office_id filter
4. Returns: List of pending approvals for that office only
5. User sees only what they have permission to see
```

### Example 3: Knowledge-Aware Answer
```
User: "What's the process for budget document approval?"

Flow:
1. AI receives question + system prompt
2. System includes relevant knowledge files in context
3. AI searches knowledge base about "budget approval"
4. AI synthesizes answer from knowledge file + database routes
5. Returns: Detailed process with current route info
```

---

## 9. Security & Permissions

### Built-In Protections:
1. **Authentication:** All AI queries require logged-in user
2. **Organization Isolation:** Users only see their org's data
3. **Role-Based Filtering:** Queries filter by user's role and office
4. **Audit Trail:** All AI queries logged in activity_logs
5. **Rate Limiting:** Prevent abuse of AI queries

### Example Permission Logic:
```typescript
// In executeTool()
if (user.role === 'CLIENT') {
  // Can see all org data
} else if (user.role === 'STAFF' || 'EMPLOYEE') {
  // Can only see their office + shared documents
} else if (user.role === 'LIAISON') {
  // Can see assigned routes + messages
}
```

---

## 10. Configuration & Environment

### .env Variables Needed:
```env
# AI Model API
AI_PROVIDER=groq              # or claude, openai
AI_API_KEY=xxx_your_key_xxx
AI_MODEL=mixtral-8x7b-32768   # or claude-3-sonnet, gpt-4

# AI Settings
AI_MAX_CONTEXT_TOKENS=4000
AI_TEMPERATURE=0.7
AI_MAX_CONVERSATIONS=1000     # per organization
```

### Nuxt Config:
```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  // ... existing config
  runtimeConfig: {
    ai: {
      apiKey: process.env.AI_API_KEY,
      provider: process.env.AI_PROVIDER,
      model: process.env.AI_MODEL,
    }
  }
});
```

---

## 11. Testing Queries for Your AI

Once deployed, test with:

**Organization Questions:**
- "What offices do we have?"
- "How many employees work here?"
- "Show me all document routes"

**Status Queries:**
- "What documents are pending approval?"
- "Who's available to be a messenger?"
- "Show me activity from the last 7 days"

**Analysis:**
- "Which office processes documents fastest?"
- "What's the most common document type?"
- "Show me documents stuck in workflow"

**Knowledge:**
- "What's our policy on [topic]?" (if knowledge files uploaded)
- "How do I submit a [document type]?"

---

## 12. Future Enhancements

- Proactive Alerts: "You have 5 documents pending approval"
- Predictive Routing: "I recommend route X for this document"
- Workflow Automation: "Auto-route documents matching criteria"
- Dashboard Integration: Embed AI insights in admin dashboard
- Mobile Support: Chat with AI from mobile devices
- Voice Assistant: Speak queries to the AI
- Document Summarization: Automatic summaries of large documents

---

## Summary

This AI system:
- ✅ Queries **live data** → always up-to-date
- ✅ Respects **permissions** → secure by default
- ✅ Auto-learns from **new features** → no retraining
- ✅ Stays in **organization context** → answers about YOUR data
- ✅ **Simple to extend** → add new tools as you add features
- ✅ **Full-stack ready** → integrates with existing Nuxt/Nitro/Sequelize stack

**No manual updates needed.** The AI grows with your system.
