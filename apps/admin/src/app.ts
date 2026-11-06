import "./styles.css";
import type {
    IAdminConfiguration,
    IAdminOverview,
    IBodyReference,
    ICubeDatasetDescriptor,
    IDatasetDraft,
    IDatasetDraftInput,
    ILayer,
    IPage,
} from "@spacexr-service/shared";
import { AdminApiError, AdminClient } from "./client";
type Child = Node | string | null | undefined | false;
type Screen = "overview" | "datasets" | "layers" | "assets" | "jobs" | "audit" | "access";
interface IIdentity {
    instanceId: string;
    tenantId: string;
    subject: string;
    scopes: string[];
}
interface IJobSummary {
    id: string;
    kind: string;
    resource_id: string;
    status: string;
    error?: string;
    created_at: number;
    updated_at: number;
}
interface IToken {
    id: string;
    tenantId: string;
    subject: string;
    scopes: string[];
    expiresAt: number;
}
/** All catalogue text enters the DOM as text nodes, never through HTML interpolation. */
function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    element.className = className;
    for (const child of children) if (child !== null && child !== undefined && child !== false) element.append(child);
    return element;
}
function button(label: string, action: () => void, className = "button"): HTMLButtonElement {
    const item = el("button", className, label);
    item.type = "button";
    item.addEventListener("click", action);
    return item;
}
function input(type: string, value = "", placeholder = ""): HTMLInputElement {
    const item = el("input");
    item.type = type;
    item.value = value;
    item.placeholder = placeholder;
    return item;
}
function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    const id = crypto.randomUUID();
    control.id = id;
    const caption = el("label", "", label);
    caption.htmlFor = id;
    return el("div", "field", caption, control, hint ? el("small", "muted", hint) : null);
}
function badge(value: string): HTMLElement {
    return el("span", "badge", value);
}
function date(value: number): string {
    return new Date(value).toLocaleString("fr-FR");
}
function bytes(value: number): string {
    return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(value / 1e6) + " Mo";
}
function details(value: unknown): HTMLElement {
    const pre = el("pre");
    pre.textContent = JSON.stringify(value, null, 2);
    return pre;
}
const app = document.querySelector<HTMLDivElement>("#app")!,
    api = new AdminClient();
let identity: IIdentity | undefined, configuration: IAdminConfiguration | undefined;
let bodies: IBodyReference[] = [],
    screen: Screen = "overview",
    renderVersion = 0;
let content = el("main"),
    feedback = el("div");
const labels: Record<Screen, string> = {
    overview: "Vue d’ensemble",
    datasets: "Datasets",
    layers: "Couches 3D",
    assets: "Assets",
    jobs: "Traitements",
    audit: "Journal",
    access: "Accès API",
};
const canWrite = (): boolean => identity?.scopes.includes("write") ?? false;
function notify(error: unknown): void {
    const text = error instanceof Error ? error.message : String(error);
    const conflict = error instanceof AdminApiError && error.status === 409;
    feedback.replaceChildren(
        el(
            "div",
            "alert error",
            conflict ? "Ce brouillon a changé. Actualisez la liste avant de reprendre." : text,
            error instanceof AdminApiError && error.requestId ? el("small", "", `Requête : ${error.requestId}`) : null,
        ),
    );
}
function run(action: () => Promise<void>): void {
    void action().catch(notify);
}
function logout(): void {
    renderVersion++;
    api.disconnect();
    identity = undefined;
    configuration = undefined;
    bodies = [];
    document.querySelectorAll("dialog").forEach((item) => item.remove());
    login();
}
/** Resolve the principal and configuration before displaying tenant data. */
function login(): void {
    const token = input("password", "", "Jeton propriétaire ou jeton API");
    token.required = true;
    token.autocomplete = "off";
    token.name = "access-token";
    const submit = el("button", "button primary", "Se connecter");
    submit.type = "submit";
    const error = el("p", "form-error");
    error.setAttribute("role", "alert");
    const form = el(
        "form",
        "login-form",
        field("Jeton d’accès", token, "Conservé uniquement en mémoire dans cet onglet."),
        error,
        submit,
    );
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        submit.disabled = true;
        error.textContent = "";
        void (async () => {
            api.authenticate(token.value);
            identity = await api.request<IIdentity>("/v1/whoami");
            const [config, catalogue] = await Promise.all([
                api.request<IAdminConfiguration>("/v1/admin/config"),
                api.request<IPage<IBodyReference>>("/v1/bodies"),
            ]);
            configuration = config;
            bodies = catalogue.items;
            token.value = "";
            screen = "overview";
            shell();
            await render();
        })().catch((failure) => {
            api.disconnect();
            identity = undefined;
            configuration = undefined;
            error.textContent = failure instanceof Error ? failure.message : "Connexion impossible";
            submit.disabled = false;
        });
    });
    app.replaceChildren(
        el(
            "main",
            "login-layout",
            el(
                "section",
                "login-intro",
                el("div", "brand-mark", "C"),
                el("p", "eyebrow", "CELESTIAL / TILE SERVICE"),
                el("h1", "", "Un point de contrôle pour vos mondes."),
                el("p", "lead", "Catalogue des sources, déclarations de terrain et suivi des publications."),
                el(
                    "div",
                    "notice",
                    "La génération des tuiles est suspendue. Les datasets enregistrés ici restent des brouillons.",
                ),
            ),
            el("section", "login-card", el("p", "eyebrow", "ADMINISTRATION"), el("h2", "", "Ouvrir une session"), form),
        ),
    );
}
function shell(): void {
    const nav = el("nav", "navigation");
    nav.setAttribute("aria-label", "Administration");
    for (const item of Object.keys(labels) as Screen[]) {
        if (item === "access" && !identity?.scopes.includes("admin")) continue;
        const link = button(
            labels[item],
            () => {
                screen = item;
                shell();
                run(render);
            },
            `nav-item${item === screen ? " selected" : ""}`,
        );
        if (item === screen) link.setAttribute("aria-current", "page");
        nav.append(link);
    }
    content = el("main", "workspace");
    content.id = "content";
    feedback = el("div", "feedback");
    feedback.setAttribute("aria-live", "polite");
    const sidebar = el(
        "aside",
        "sidebar",
        el(
            "div",
            "brand",
            el("div", "brand-mark small", "C"),
            el("div", "", el("strong", "", "CELESTIAL"), el("small", "", "Tile administration")),
        ),
        nav,
        el(
            "div",
            "sidebar-footer",
            el("small", "", "Instance"),
            el("strong", "", configuration!.instanceId),
            el("small", "", `Tenant : ${identity!.tenantId}`),
            button("Se déconnecter", logout, "button quiet"),
        ),
    );
    app.replaceChildren(
        el(
            "div",
            "layout",
            sidebar,
            el(
                "div",
                "main-column",
                el(
                    "header",
                    "topbar",
                    el("span", "", configuration!.name),
                    badge("Génération suspendue"),
                    button("Actualiser", () => run(render), "button secondary"),
                ),
                feedback,
                content,
            ),
        ),
    );
}
function heading(title: string, description: string, action?: HTMLElement): void {
    content.append(
        el(
            "div",
            "page-heading",
            el("div", "", el("p", "eyebrow", "ADMINISTRATION"), el("h1", "", title), el("p", "muted", description)),
            action,
        ),
    );
}
function empty(message: string): HTMLElement {
    return el("div", "empty", el("strong", "", "Aucun élément"), el("p", "muted", message));
}
/** Cursor pagination retains no hidden assumption that the first page is the full inventory. */
async function paged<T>(
    path: string,
    headers: string[],
    row: (item: T) => Node[],
    version: number,
    emptyMessage: string,
): Promise<void> {
    let response = await api.request<IPage<T>>(path);
    if (version !== renderVersion) return;
    if (!response.items.length) {
        content.append(empty(emptyMessage));
        return;
    }
    const tbody = el("tbody");
    const append = (items: T[]): void => {
        for (const item of items) tbody.append(el("tr", "", ...row(item).map((cell) => el("td", "", cell))));
    };
    append(response.items);
    content.append(
        el(
            "div",
            "table-scroll",
            el("table", "", el("thead", "", el("tr", "", ...headers.map((text) => el("th", "", text)))), tbody),
        ),
    );
    const more = button(
        "Charger la suite",
        () =>
            run(async () => {
                more.disabled = true;
                try {
                    const url = new URL(path, location.origin);
                    url.searchParams.set("cursor", response.cursor!);
                    const next = await api.request<IPage<T>>(url.pathname + url.search);
                    if (version !== renderVersion) return;
                    append(next.items);
                    response = next;
                    more.hidden = !response.cursor;
                } finally {
                    more.disabled = false;
                }
            }),
        "button secondary load-more",
    );
    more.hidden = !response.cursor;
    content.append(more);
}
async function render(): Promise<void> {
    const version = ++renderVersion;
    feedback.replaceChildren();
    content.replaceChildren();
    if (screen === "overview") {
        heading("Vue d’ensemble", "Votre catalogue et vos ressources, pour cette instance et ce tenant.");
        const overview = await api.request<IAdminOverview>("/v1/admin/overview");
        if (version !== renderVersion) return;
        content.append(
            el(
                "div",
                "metrics",
                ...[
                    ["Datasets en brouillon", overview.datasets],
                    ["Couches 3D", overview.layers],
                    ["Assets", overview.assets],
                    ["Tâches actives", overview.queuedJobs + overview.runningJobs],
                ].map(([label, value]) =>
                    el("article", "metric", el("span", "muted", String(label)), el("strong", "", String(value))),
                ),
            ),
        );
        content.append(
            el(
                "section",
                "panel",
                el("h2", "", "Préparer le catalogue"),
                el(
                    "p",
                    "",
                    "Déclarez les sources, leurs référentiels et le découpage cible. Chaque dataset décrit ses faces cubiques et ses sous-arbres locaux.",
                ),
                el(
                    "p",
                    "muted",
                    "L’enregistrement d’un brouillon ne télécharge aucune source et ne génère aucune tuile.",
                ),
                button(
                    "Voir les datasets",
                    () => {
                        screen = "datasets";
                        shell();
                        run(render);
                    },
                    "button primary",
                ),
            ),
        );
        content.append(
            el(
                "section",
                "panel",
                el("h2", "", "Références disponibles"),
                el(
                    "div",
                    "body-cards",
                    ...bodies.map((body) =>
                        el(
                            "article",
                            "body-card",
                            el("strong", "", body.name),
                            el("small", "muted", `Catalogue : ${body.profile.catalogueName}`),
                            el(
                                "small",
                                "muted",
                                `Rayon équatorial : ${new Intl.NumberFormat("fr-FR").format(body.semiMajorAxisMetres)} m`,
                            ),
                        ),
                    ),
                ),
                el("p", "muted", "La surface de référence d’un dataset peut différer de celle du catalogue."),
            ),
        );
        content.append(
            el(
                "p",
                "muted",
                `Volume déclaré des assets : ${bytes(overview.declaredAssetBytes)}. Cette valeur ne mesure pas le stockage réel du bucket R2.`,
            ),
        );
    } else if (screen === "datasets") {
        heading(
            "Datasets",
            "Déclarations de sources et de terrain cubique. Tous les enregistrements restent en brouillon.",
            canWrite() ? button("Nouveau dataset", () => editDataset(), "button primary") : undefined,
        );
        await paged<IDatasetDraft>(
            "/v1/datasets?limit=25",
            ["Dataset", "Corps / contenu", "Niveaux", "État", ""],
            (dataset) => [
                el("div", "", el("strong", "", dataset.name), el("small", "muted mono", dataset.id)),
                el("span", "", `${dataset.descriptor.body} / ${dataset.descriptor.content}`),
                el("span", "", `${dataset.descriptor.minLOD} à ${dataset.descriptor.maxLOD}`),
                badge("Brouillon"),
                button(canWrite() ? "Ouvrir / modifier" : "Consulter", () => editDataset(dataset), "button secondary"),
            ],
            version,
            "Ajoutez une première source et son descripteur cubique.",
        );
    } else if (screen === "layers") {
        heading(
            "Couches 3D",
            "Préparez les couches et leur référentiel. La publication est suspendue.",
            canWrite() ? button("Nouvelle couche", () => editLayer(), "button primary") : undefined,
        );
        await paged<Pick<ILayer, "id" | "name" | "visibility" | "version">>(
            "/v1/layers?limit=25",
            ["Couche", "Visibilité", "Version", ""],
            (layer) => [
                el("strong", "", layer.name),
                badge(layer.visibility === "private" ? "Privée" : "Publique"),
                el("span", "", String(layer.version)),
                button(
                    "Ouvrir",
                    () => run(async () => editLayer(await api.request<ILayer>(`/v1/layers/${layer.id}`))),
                    "button secondary",
                ),
            ],
            version,
            "Créez une couche associée à un corps ou à un référentiel local.",
        );
    } else if (screen === "jobs") {
        heading("Traitements", "État des tâches existantes. Aucune nouvelle génération n’est déclenchée ici.");
        await paged<IJobSummary>(
            "/v1/jobs?limit=25",
            ["Tâche", "Type", "État", "Mise à jour", ""],
            (job) => [
                el("span", "mono", job.id.slice(0, 12)),
                el("span", "", job.kind),
                badge(job.status),
                el("span", "", date(job.updated_at)),
                button("Détails", () => inspect("Traitement", job), "button secondary"),
            ],
            version,
            "Aucun traitement n’a été créé pour ce tenant.",
        );
    } else if (screen === "assets") {
        heading("Assets", "Inventaire des fichiers déclarés. L’import de nouveaux fichiers est désactivé.");
        await paged<{ id: string; name: string; byteLength: number; contentType: string; status: string }>(
            "/v1/assets?limit=25",
            ["Fichier", "Format", "Taille déclarée", "État"],
            (asset) => [
                el("strong", "", asset.name),
                el("span", "", asset.contentType),
                el("span", "", bytes(asset.byteLength)),
                badge(asset.status),
            ],
            version,
            "Aucun asset n’est enregistré dans cette instance locale.",
        );
    } else if (screen === "audit") {
        heading("Journal", "Opérations du tenant courant. Les valeurs des jetons ne sont jamais enregistrées.");
        await paged<{ id: string; operation: string; resource_id: string; created_at: number }>(
            "/v1/audit?limit=25",
            ["Date", "Opération", "Ressource"],
            (item) => [
                el("span", "", date(item.created_at)),
                el("strong", "", item.operation),
                el("span", "mono", item.resource_id ?? ""),
            ],
            version,
            "Les opérations apparaîtront ici après la première modification.",
        );
    } else {
        heading(
            "Accès API",
            "Créez des jetons limités à un tenant et révoquez-les individuellement.",
            button("Créer un jeton", createToken, "button primary"),
        );
        await paged<IToken>(
            "/v1/tokens?limit=25",
            ["Tenant", "Permissions", "Expiration", ""],
            (token) => [
                el("strong", "", token.tenantId),
                el("span", "", token.scopes.join(", ")),
                el("span", "", date(token.expiresAt)),
                button(
                    "Révoquer",
                    () =>
                        confirmAction(
                            "Révoquer ce jeton ?",
                            "Les prochains appels utilisant ce jeton seront refusés.",
                            async () => {
                                await api.request(`/v1/tokens/${token.id}`, "DELETE");
                            },
                        ),
                    "button danger",
                ),
            ],
            version,
            "Le jeton propriétaire se configure côté serveur et n’apparaît pas dans cette liste.",
        );
    }
}
function modal(title: string, description: string): { body: HTMLElement; close: () => void } {
    const dialog = el("dialog", "dialog");
    const close = (): void => {
        dialog.close();
        dialog.remove();
    };
    const body = el("div", "dialog-body");
    dialog.append(
        el(
            "div",
            "dialog-heading",
            el("div", "", el("h2", "", title), el("p", "muted", description)),
            button("Fermer", close, "button secondary"),
        ),
        body,
    );
    dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        close();
    });
    document.body.append(dialog);
    dialog.showModal();
    return { body, close };
}
function inspect(title: string, value: unknown): void {
    modal(title, "Données retournées par l’API.").body.append(details(value));
}
function formSubmit(
    form: HTMLFormElement,
    save: HTMLButtonElement,
    action: () => Promise<void>,
    close: () => void,
): void {
    const error = el("p", "form-error");
    error.setAttribute("role", "alert");
    form.append(error);
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        save.disabled = true;
        error.textContent = "";
        void action()
            .then(async () => {
                close();
                await render();
            })
            .catch((failure) => {
                error.textContent =
                    failure instanceof AdminApiError && failure.status === 409
                        ? "Version modifiée. Fermez et actualisez la liste avant de reprendre."
                        : failure instanceof Error
                          ? failure.message
                          : String(failure);
                save.disabled = false;
            });
    });
}
function confirmAction(title: string, description: string, action: () => Promise<void>): void {
    const { body, close } = modal(title, description),
        form = el("form");
    const save = el("button", "button danger", "Confirmer");
    save.type = "submit";
    form.append(save);
    formSubmit(form, save, action, close);
    body.append(form);
}
function defaultDescriptor(body: IBodyReference): ICubeDatasetDescriptor {
    const lunar = body.id === "moon",
        radius = lunar ? 1737400 : body.semiMajorAxisMetres;
    return {
        scheme: "spacexr-cube-equiangular/1",
        body: body.profile.catalogueName,
        frame: lunar ? "MOON_ME" : body.profile.referenceFrame,
        referenceRadii: [radius, radius, lunar ? radius : body.semiMinorAxisMetres],
        content: "elevation",
        encoding: "terrarium",
        tileSize: 256,
        minLOD: 0,
        maxLOD: 0,
        subtrees: [],
        tiles: `https://tiles.avegalaxar.com/${body.id}/dataset/{face}/{z}/{x}/{y}.png`,
    };
}
function editDataset(dataset?: IDatasetDraft): void {
    if (!canWrite() && dataset) {
        inspect(dataset.name, dataset);
        return;
    }
    const { body, close } = modal(
        dataset ? "Modifier le dataset" : "Nouveau dataset",
        "Déclaration préparatoire. Aucun fichier n’est téléchargé ou publié.",
    );
    const name = input("text", dataset?.name);
    name.required = true;
    name.maxLength = 200;
    const selectedBody =
        bodies.find((item) => item.id === dataset?.bodyId) ?? bodies.find((item) => item.id === "moon") ?? bodies[0];
    if (!selectedBody) {
        body.append(el("p", "", "Aucun corps n’est configuré."));
        return;
    }
    const bodySelect = el("select");
    for (const item of bodies) {
        const option = el("option", "", item.name);
        option.value = item.id;
        option.selected = item.id === selectedBody.id;
        bodySelect.append(option);
    }
    const source = input("url", dataset?.source.url, "https://…");
    source.required = true;
    const attribution = input("text", dataset?.source.attribution);
    attribution.required = true;
    attribution.maxLength = 1000;
    const notes = el("textarea");
    notes.rows = 3;
    notes.maxLength = 4000;
    notes.value = dataset?.source.notes ?? "";
    const descriptor = el("textarea", "code-editor");
    descriptor.rows = 19;
    descriptor.spellcheck = false;
    descriptor.value = JSON.stringify(dataset?.descriptor ?? defaultDescriptor(selectedBody), null, 2);
    let template = descriptor.value;
    bodySelect.addEventListener("change", () => {
        if (!dataset && descriptor.value === template) {
            descriptor.value = JSON.stringify(
                defaultDescriptor(bodies.find((item) => item.id === bodySelect.value)!),
                null,
                2,
            );
            template = descriptor.value;
        }
    });
    const save = el("button", "button primary", "Enregistrer le brouillon");
    save.type = "submit";
    const actions = el("div", "actions", save);
    if (dataset)
        actions.append(
            button(
                "Supprimer",
                () => {
                    close();
                    confirmAction("Supprimer ce brouillon ?", dataset.name, async () => {
                        await api.request(`/v1/datasets/${dataset.id}`, "DELETE", { version: dataset.version });
                    });
                },
                "button danger",
            ),
        );
    const form = el(
        "form",
        "editor-form",
        field("Nom", name),
        field("Corps", bodySelect),
        field("Source publique", source),
        field("Attribution", attribution),
        field("Notes sur la source", notes),
        field(
            "Descripteur cubique",
            descriptor,
            "Rayons en mètres. Hauteurs radiales pour le DEM. Vérifiez le référentiel et la version de chaque source.",
        ),
        actions,
    );
    formSubmit(
        form,
        save,
        async () => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(descriptor.value);
            } catch {
                throw new Error("Le descripteur JSON n’est pas valide.");
            }
            const value: IDatasetDraftInput = {
                name: name.value,
                bodyId: bodySelect.value,
                source: { url: source.value, attribution: attribution.value, notes: notes.value },
                descriptor: parsed as ICubeDatasetDescriptor,
            };
            await api.request(
                dataset ? `/v1/datasets/${dataset.id}` : "/v1/datasets",
                dataset ? "PATCH" : "POST",
                dataset ? { ...value, version: dataset.version } : value,
            );
        },
        close,
    );
    body.append(form);
}
function editLayer(layer?: ILayer): void {
    if (!canWrite() && layer) {
        inspect(layer.name, layer);
        return;
    }
    const { body, close } = modal(
        layer ? "Modifier la couche" : "Nouvelle couche",
        "La publication et la génération sont suspendues.",
    );
    const name = input("text", layer?.name);
    name.required = true;
    name.maxLength = 200;
    const reference = el("select");
    for (const item of bodies) {
        const option = el("option", "", item.name);
        option.value = `body:${item.id}`;
        reference.append(option);
    }
    for (const item of configuration!.frames) {
        const option = el("option", "", item.name);
        option.value = `frame:${item.id}`;
        reference.append(option);
    }
    if (layer) {
        reference.value = layer.bodyId ? `body:${layer.bodyId}` : `frame:${layer.frameId}`;
        reference.disabled = true;
    }
    const visibility = el("select");
    for (const [value, label] of [
        ["private", "Privée"],
        ["public", "Publique"],
    ]) {
        const option = el("option", "", label);
        option.value = value;
        visibility.append(option);
    }
    visibility.value = layer?.visibility ?? "private";
    const save = el("button", "button primary", "Enregistrer");
    save.type = "submit";
    const actions = el("div", "actions", save);
    if (layer)
        actions.append(
            button(
                "Supprimer",
                () => {
                    close();
                    confirmAction("Supprimer cette couche ?", layer.name, async () => {
                        await api.request(`/v1/layers/${layer.id}`, "DELETE");
                    });
                },
                "button danger",
            ),
        );
    const form = el(
        "form",
        "editor-form",
        field("Nom", name),
        field("Référentiel", reference),
        field("Visibilité", visibility),
        actions,
    );
    formSubmit(
        form,
        save,
        async () => {
            const [kind, id] = reference.value.split(":");
            await api.request(
                layer ? `/v1/layers/${layer.id}` : "/v1/layers",
                layer ? "PATCH" : "POST",
                layer
                    ? { name: name.value, visibility: visibility.value, version: layer.version }
                    : {
                          name: name.value,
                          visibility: visibility.value,
                          ...(kind === "body" ? { bodyId: id } : { frameId: id }),
                      },
            );
        },
        close,
    );
    body.append(form);
}
function createToken(): void {
    const { body, close } = modal(
        "Créer un jeton",
        "La valeur complète est affichée une seule fois. Conservez-la hors du dépôt.",
    );
    const tenant = input("text", identity!.tenantId);
    tenant.required = true;
    tenant.pattern = "[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}";
    const duration = input("number", "7");
    duration.min = "1";
    duration.max = "365";
    duration.required = true;
    const read = input("checkbox");
    read.checked = true;
    read.disabled = true;
    const write = input("checkbox"),
        publish = input("checkbox");
    const save = el("button", "button primary", "Créer le jeton");
    save.type = "submit";
    const form = el(
        "form",
        "editor-form",
        field("Tenant", tenant),
        field("Durée, en jours", duration),
        el("div", "check-row", field("Lecture", read), field("Écriture", write), field("Publication", publish)),
        save,
    );
    const error = el("p", "form-error");
    form.append(error);
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        save.disabled = true;
        error.textContent = "";
        void api
            .request<{ token: string }>("/v1/tokens", "POST", {
                tenantId: tenant.value,
                scopes: ["read", ...(write.checked ? ["write"] : []), ...(publish.checked ? ["publish"] : [])],
                expiresInSeconds: Number(duration.value) * 86400,
            })
            .then((result) => {
                const value = el("textarea", "code-editor");
                value.readOnly = true;
                value.rows = 3;
                value.value = result.token;
                body.replaceChildren(
                    el("p", "", "Copiez ce jeton maintenant. Il ne sera plus affiché après la fermeture."),
                    field("Nouveau jeton", value),
                    button(
                        "Copier",
                        () =>
                            run(async () => {
                                await navigator.clipboard.writeText(value.value);
                            }),
                        "button primary",
                    ),
                    button(
                        "Terminer",
                        () => {
                            value.value = "";
                            close();
                            run(render);
                        },
                        "button secondary",
                    ),
                );
            })
            .catch((failure) => {
                error.textContent = failure instanceof Error ? failure.message : String(failure);
                save.disabled = false;
            });
    });
    body.append(form);
}
login();
