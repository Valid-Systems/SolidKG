import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SolidKG } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Django end-to-end framework extraction', () => {
  let tmpDir: string | undefined;
  let extraDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (extraDir) fs.rmSync(extraDir, { recursive: true, force: true });
    tmpDir = undefined;
    extraDir = undefined;
  });

  it('creates a route->view edge from urls.py to view class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-django-'));
    fs.writeFileSync(path.join(tmpDir, 'manage.py'), '# marker\n');
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'django==4.2\n');
    fs.mkdirSync(path.join(tmpDir, 'users'));
    fs.writeFileSync(path.join(tmpDir, 'users/__init__.py'), '');
    fs.writeFileSync(
      path.join(tmpDir, 'users/views.py'),
      'class UserListView:\n    def get(self, request): pass\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'users/urls.py'),
      'from django.urls import path\n' +
        'from users.views import UserListView\n' +
        'urlpatterns = [path("users/", UserListView.as_view(), name="user-list")]\n'
    );

    const cg = SolidKG.initSync(tmpDir);
    await cg.indexAll();

    // Route node exists
    const routes = cg.getNodesByKind('route');
    expect(routes.length).toBeGreaterThan(0);
    const route = routes.find((n) => n.name === 'users/');
    expect(route).toBeDefined();

    // View class exists
    const classNodes = cg.getNodesByKind('class');
    const view = classNodes.find((n) => n.name === 'UserListView');
    expect(view).toBeDefined();

    // Edge route -> view exists
    const edges = cg.getOutgoingEdges(route!.id);
    const toView = edges.find((e) => e.target === view!.id);
    expect(toView).toBeDefined();
    expect(toView!.kind).toBe('references');

    cg.close();
  });

  it('does not leak project-root framework detection into an unrelated extra root', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-django-root-'));
    extraDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-django-extra-'));
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'django==4.2\n');
    fs.writeFileSync(path.join(tmpDir, 'app.py'), 'def root_marker(): return 1\n');
    fs.writeFileSync(
      path.join(extraDir, 'urls.py'),
      'def local_path(name, handler): return name\n' +
        'def handler(): pass\n' +
        'path("not-django/", handler)\n'
    );

    const cg = SolidKG.initSync(tmpDir, { extraRoots: [extraDir] });
    try {
      await cg.indexAll();

      const extraLabel = path.basename(extraDir);
      const leakedRoute = cg.getNodesByKind('route').find((node) => node.filePath === `@${extraLabel}/urls.py`);
      expect(leakedRoute).toBeUndefined();
    } finally {
      cg.close();
    }
  });
});

describe('Flask end-to-end framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('resolves stacked routes across @login_required to a view named after a builtin (index)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flask-'));
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask==3.0\n');
    fs.writeFileSync(
      path.join(tmpDir, 'app.py'),
      'from flask import Blueprint, render_template\n' +
        'from flask_login import login_required\n' +
        'bp = Blueprint("main", __name__)\n' +
        '\n' +
        '@bp.route("/", methods=["GET", "POST"])\n' +
        '@bp.route("/index", methods=["GET", "POST"])\n' +
        '@login_required\n' +
        'def index():\n' +
        '    return render_template("index.html")\n'
    );

    const cg = SolidKG.initSync(tmpDir);
    await cg.indexAll();

    // Both stacked @bp.route decorators are extracted (the second was previously
    // dropped because @login_required broke the "def must follow" assumption).
    const routes = cg.getNodesByKind('route');
    expect(routes.map((r) => r.name).sort()).toEqual(['GET /', 'GET /index']);

    // The view function exists even though its name is a Python builtin method.
    const fn = cg.getNodesByKind('function').find((n) => n.name === 'index');
    expect(fn).toBeDefined();

    // Both routes resolve to it — exercises the bare-name builtin guard, which
    // previously filtered the `index` reference as a builtin method.
    for (const route of routes) {
      const edges = cg.getOutgoingEdges(route.id);
      const toView = edges.find((e) => e.target === fn!.id && e.kind === 'references');
      expect(toView, `route ${route.name} should resolve to index()`).toBeDefined();
    }

    cg.close();
  });
});

describe('FastAPI Jinja2 template framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('connects TemplateResponse routes to handler functions and Jinja template files', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fastapi-jinja-'));
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'fastapi==0.111\njinja2==3.1\n');
    fs.mkdirSync(path.join(tmpDir, 'templates'));
    fs.writeFileSync(path.join(tmpDir, 'templates', 'index.html'), '{% block content %}Hello{% endblock %}\n');
    fs.writeFileSync(
      path.join(tmpDir, 'main.py'),
      'from fastapi import FastAPI, Request\n' +
        'from fastapi.templating import Jinja2Templates\n' +
        'app = FastAPI()\n' +
        'templates = Jinja2Templates(directory="templates")\n' +
        '@app.get("/")\n' +
        'async def home(request: Request):\n' +
        '    return templates.TemplateResponse("index.html", {"request": request})\n'
    );

    const cg = SolidKG.initSync(tmpDir);
    await cg.indexAll();

    const route = cg.getNodesByKind('route').find((node) => node.name === 'GET /');
    const handler = cg.getNodesByKind('function').find((node) => node.name === 'home');
    const template = cg.getNodesByKind('file').find((node) => node.filePath.endsWith('templates/index.html'));
    expect(route).toBeDefined();
    expect(handler).toBeDefined();
    expect(template).toBeDefined();

    const routeEdges = cg.getOutgoingEdges(route!.id);
    expect(routeEdges.find((edge) => edge.target === handler!.id && edge.kind === 'references')).toBeDefined();
    expect(routeEdges.find((edge) => edge.target === template!.id && edge.kind === 'references')).toBeDefined();
    const routeBinding = cg.getHyperedgesByNode(route!.id).find((relation) => relation.hyperedge.kind === 'route_binding');
    expect(routeBinding?.members.some((member) => member.role === 'template' && member.nodeId === template!.id)).toBe(true);

    cg.close();
  });

});

describe('ASP.NET Razor template framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('connects MVC actions returning View() to matching Razor files', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-aspnet-razor-'));
    fs.writeFileSync(path.join(tmpDir, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n');
    fs.mkdirSync(path.join(tmpDir, 'Controllers'));
    fs.mkdirSync(path.join(tmpDir, 'Views', 'Home'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Controllers', 'HomeController.cs'),
      'using Microsoft.AspNetCore.Mvc;\n' +
        'public class HomeController : Controller {\n' +
        '  [HttpGet("/")]\n' +
        '  public IActionResult Index() { return View(); }\n' +
        '}\n'
    );
    fs.writeFileSync(path.join(tmpDir, 'Views', 'Home', 'Index.cshtml'), '@model HomeViewModel\n<p>@Model.Title</p>\n');

    const cg = SolidKG.initSync(tmpDir);
    await cg.indexAll();

    const route = cg.getNodesByKind('route').find((node) => node.name === 'GET /');
    const view = cg.getNodesByKind('file').find((node) => node.filePath.endsWith('Views/Home/Index.cshtml'));
    expect(route).toBeDefined();
    expect(view).toBeDefined();
    expect(cg.getOutgoingEdges(route!.id).find((edge) => edge.target === view!.id && edge.kind === 'references')).toBeDefined();

    cg.close();
  });
});

describe('Hono end-to-end framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('creates mounted route nodes and resolves them to sub-router handlers', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hono-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ dependencies: { hono: '^4.0.0' } }));
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'app.ts'),
      `import { Hono } from 'hono';

const app = new Hono();
const api = new Hono();

function listBooks(c: unknown) { return c; }
function createBook(c: unknown) { return c; }

api.get('/books', listBooks);
api.post('/books', createBook);
app.route('/api', api);
`
    );

    const cg = SolidKG.initSync(tmpDir);
    await cg.indexAll();

    const routes = cg.getNodesByKind('route');
    expect(routes.map((route) => route.name).sort()).toEqual(['GET /api/books', 'POST /api/books']);
    const handlers = cg.getNodesByKind('function');
    const listBooks = handlers.find((node) => node.name === 'listBooks');
    expect(listBooks).toBeDefined();
    const getRoute = routes.find((route) => route.name === 'GET /api/books');
    expect(getRoute).toBeDefined();
    const edge = cg.getOutgoingEdges(getRoute!.id).find((candidate) => candidate.target === listBooks!.id && candidate.kind === 'references');
    expect(edge).toBeDefined();
    expect(cg.getHyperedgesByNode(getRoute!.id).some((relation) => relation.hyperedge.kind === 'route_binding')).toBe(true);

    cg.close();
  });
});

describe('Spring Java enterprise framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('connects an OpenFeign client method to the matching RestController handler without same-name package over-linking', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-spring-feign-'));
    fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<dependency>spring-boot</dependency>\n');
    fs.mkdirSync(path.join(tmpDir, 'src/main/java/com/example/users'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src/main/java/com/example/admin'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/main/java/com/example/users/UserClient.java'),
      'package com.example.users;\n' +
        'import org.springframework.cloud.openfeign.FeignClient;\n' +
        'import org.springframework.web.bind.annotation.GetMapping;\n' +
        '@FeignClient(name = "users", path = "/api/users")\n' +
        'interface UserClient {\n' +
        '  @GetMapping("/{id}")\n' +
        '  UserDto getUser(String id);\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/main/java/com/example/users/UserController.java'),
      'package com.example.users;\n' +
        'import org.springframework.web.bind.annotation.GetMapping;\n' +
        'import org.springframework.web.bind.annotation.RequestMapping;\n' +
        'import org.springframework.web.bind.annotation.RestController;\n' +
        '@RestController\n' +
        '@RequestMapping("/api/users")\n' +
        'public class UserController {\n' +
        '  @GetMapping("/{id}")\n' +
        '  public UserDto getUser(String id) { return new UserDto(); }\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/main/java/com/example/admin/AdminController.java'),
      'package com.example.admin;\n' +
        'public class AdminController {\n' +
        '  public UserDto getUser(String id) { return new UserDto(); }\n' +
        '}\n'
    );

    const cg = SolidKG.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method').filter((node) => node.name === 'getUser');
    const clientMethod = methods.find((node) => node.filePath.endsWith('UserClient.java'));
    const controllerMethod = methods.find((node) => node.filePath.endsWith('UserController.java'));
    const adminMethod = methods.find((node) => node.filePath.endsWith('AdminController.java'));
    expect(clientMethod).toBeDefined();
    expect(controllerMethod).toBeDefined();
    expect(adminMethod).toBeDefined();

    const pathToController = cg.findPath(clientMethod!.id, controllerMethod!.id, ['calls', 'references']);
    expect(pathToController?.map((entry) => entry.node.name)).toContain('GET /api/users/{id}');
    expect(cg.findPath(clientMethod!.id, adminMethod!.id, ['calls', 'references'])).toBeNull();

    const route = cg.getNodesByKind('route').find((node) => node.name === 'GET /api/users/{id}');
    expect(route).toBeDefined();
    expect(cg.getHyperedgesByNode(route!.id).some((relation) => relation.hyperedge.kind === 'route_binding')).toBe(true);

    cg.close();
  });

  it('connects SqlSessionTemplate statement IDs to namespace-qualified MyBatis XML SQL mappings', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mybatis-'));
    fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<dependency>mybatis-spring</dependency>\n');
    fs.mkdirSync(path.join(tmpDir, 'src/main/java/com/example/users'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src/main/resources/mappers'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/main/java/com/example/users/UserRepository.java'),
      'package com.example.users;\n' +
        'import org.mybatis.spring.SqlSessionTemplate;\n' +
        'public class UserRepository {\n' +
        '  private SqlSessionTemplate sqlSessionTemplate;\n' +
        '  public User findById(String id) {\n' +
        '    return sqlSessionTemplate.selectOne("com.example.users.UserMapper.findById", id);\n' +
        '  }\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/main/resources/mappers/UserMapper.xml'),
      '<mapper namespace="com.example.users.UserMapper">\n' +
        '  <select id="findById" resultType="User">select * from users</select>\n' +
        '</mapper>\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/main/resources/mappers/AdminMapper.xml'),
      '<mapper namespace="com.example.admin.UserMapper">\n' +
        '  <select id="findById" resultType="User">select * from admins</select>\n' +
        '</mapper>\n'
    );

    const cg = SolidKG.initSync(tmpDir);
    await cg.indexAll();

    const repositoryMethod = cg.getNodesByKind('method').find((node) => node.filePath.endsWith('UserRepository.java') && node.name === 'findById');
    const userStatement = cg.getNodesByKind('method').find((node) => node.name === 'com.example.users.UserMapper.findById');
    const adminStatement = cg.getNodesByKind('method').find((node) => node.name === 'com.example.admin.UserMapper.findById');
    expect(repositoryMethod).toBeDefined();
    expect(userStatement).toBeDefined();
    expect(adminStatement).toBeDefined();

    expect(cg.findPath(repositoryMethod!.id, userStatement!.id, ['calls'])).not.toBeNull();
    expect(cg.findPath(repositoryMethod!.id, adminStatement!.id, ['calls'])).toBeNull();

    cg.close();
  });
});

describe('dbt Databricks static framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('links model refs, sources, and macros from statically parseable SQL/Jinja', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dbt-'));
    fs.writeFileSync(path.join(tmpDir, 'dbt_project.yml'), 'name: analytics\nprofile: databricks\n');
    fs.mkdirSync(path.join(tmpDir, 'models', 'staging'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'models', 'marts'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'macros'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'models', 'sources.yml'),
      'version: 2\n' +
        'sources:\n' +
        '  - name: raw\n' +
        '    tables:\n' +
        '      - name: orders\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'macros', 'money.sql'),
      '{% macro cents_to_dollars(column_name) %}\n' +
        '  ({{ column_name }} / 100.0)\n' +
        '{% endmacro %}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'models', 'staging', 'stg_orders.sql'),
      "{{ config(materialized='view') }}\n" +
        'select id, amount_cents\n' +
        "from {{ source('raw', 'orders') }}\n"
    );
    fs.writeFileSync(
      path.join(tmpDir, 'models', 'marts', 'fct_orders.sql'),
      "{{ config(materialized='incremental', file_format='delta') }}\n" +
        'select id, {{ cents_to_dollars(\'amount_cents\') }} as amount\n' +
        "from {{ ref('stg_orders') }}\n"
    );

    const cg = SolidKG.initSync(tmpDir);
    await cg.indexAll();

    const models = cg.getNodesByKind('struct');
    const fctOrders = models.find((node) => node.name === 'fct_orders');
    const stgOrders = models.find((node) => node.name === 'stg_orders');
    const rawOrders = models.find((node) => node.name === 'raw.orders');
    const macro = cg.getNodesByKind('function').find((node) => node.name === 'cents_to_dollars');
    expect(fctOrders).toBeDefined();
    expect(stgOrders).toBeDefined();
    expect(rawOrders).toBeDefined();
    expect(macro).toBeDefined();

    expect(cg.findPath(fctOrders!.id, stgOrders!.id, ['references'])).not.toBeNull();
    expect(cg.findPath(fctOrders!.id, macro!.id, ['calls'])).not.toBeNull();
    expect(cg.findPath(stgOrders!.id, rawOrders!.id, ['references'])).not.toBeNull();

    cg.close();
  });
});

describe('Flutter end-to-end — setState→build synthesis', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('synthesizes a handler→build edge when a State method calls setState', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flutter-'));
    fs.writeFileSync(
      path.join(tmpDir, 'main.dart'),
      'import "package:flutter/material.dart";\n' +
        'class CounterPage extends StatefulWidget {\n' +
        '  @override\n' +
        '  State<CounterPage> createState() => _CounterPageState();\n' +
        '}\n' +
        'class _CounterPageState extends State<CounterPage> {\n' +
        '  int _count = 0;\n' +
        '  void _increment() {\n' +
        '    setState(() {\n' +
        '      _count++;\n' +
        '    });\n' +
        '  }\n' +
        '  @override\n' +
        '  Widget build(BuildContext context) {\n' +
        '    return Text("$_count");\n' +
        '  }\n' +
        '}\n'
    );

    const cg = SolidKG.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const increment = methods.find((n) => n.name === '_increment');
    const build = methods.find((n) => n.name === 'build');
    expect(increment).toBeDefined();
    expect(build).toBeDefined();

    // setState re-runs build (Flutter-internal, no static edge). The synthesizer
    // bridges the handler → build so the "tap → setState → rebuilt UI" flow connects.
    const edges = cg.getOutgoingEdges(increment!.id);
    const toBuild = edges.find((e) => e.target === build!.id && e.kind === 'calls');
    expect(toBuild, '_increment should reach build via setState synthesis').toBeDefined();

    cg.close();
  });
});

describe('C++ end-to-end — virtual override synthesis', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('bridges a base virtual method to the subclass override', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-'));
    fs.writeFileSync(
      path.join(tmpDir, 'iter.cpp'),
      'class Iterator {\n' +
        ' public:\n' +
        '  virtual void Next() { }\n' +
        '};\n' +
        'class DBIter : public Iterator {\n' +
        ' public:\n' +
        '  void Next() override { advance(); }\n' +
        '  void advance() { }\n' +
        '};\n'
    );

    const cg = SolidKG.initSync(tmpDir);
    await cg.indexAll();

    // Two methods named Next: the base virtual (lower line) and the override.
    const nexts = cg
      .getNodesByKind('method')
      .filter((n) => n.name === 'Next')
      .sort((a, b) => a.startLine - b.startLine);
    expect(nexts.length).toBe(2);
    const [baseNext, overrideNext] = nexts;

    // A vtable call to Iterator::Next dispatches to DBIter::Next — bridge it so
    // trace/callees from the interface method reaches the implementation.
    const edge = cg
      .getOutgoingEdges(baseNext!.id)
      .find((e) => e.target === overrideNext!.id && e.kind === 'calls');
    expect(edge, 'Iterator::Next should reach DBIter::Next via override synthesis').toBeDefined();

    cg.close();
  });
});
