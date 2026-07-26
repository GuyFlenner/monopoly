# Python & FastAPI Best Practices Checklist

## Python-Specific Best Practices (2026)

### 1. Type Hints & Type Safety
- [ ] All function signatures have type hints
- [ ] Use `Optional[T]` or `T | None` (Python 3.10+) for nullable values
- [ ] Complex types use `typing` module (List, Dict, Union, etc.)
- [ ] Use `TypedDict` for structured dictionaries
- [ ] Consider `mypy` or `pyright` for static type checking

**Example**:
```python
# Good
async def get_user(user_id: int) -> Optional[User]:
    return await db.fetch_user(user_id)


# Bad
def get_user(user_id):
    return db.fetch_user(user_id)
```

### 2. Async/Await Patterns
- [ ] Use `async def` for I/O-bound operations (DB, API calls, file I/O)
- [ ] Use regular `def` for CPU-bound or synchronous library calls
- [ ] Always `await` async functions
- [ ] Use `asyncio.gather()` for parallel async operations
- [ ] Properly manage async context managers (`async with`)

**Common Mistakes**:
```python
# ❌ Bad: Not awaiting async function
user = get_user_async(user_id)  # Returns coroutine, not result

# ✅ Good: Await async function
user = await get_user_async(user_id)


# ❌ Bad: Using async for CPU-bound work
async def calculate_fibonacci(n):
    # Synchronous calculation doesn't benefit from async
    pass


# ✅ Good: Use sync for CPU-bound
def calculate_fibonacci(n: int) -> int:
    # CPU-bound work
    pass
```

### 3. Error Handling
- [ ] Use specific exception types (not bare `except:`)
- [ ] Catch exceptions at appropriate level
- [ ] Log errors with context (user ID, request ID, etc.)
- [ ] Clean up resources in `finally` or use context managers
- [ ] Don't swallow exceptions silently

**Best Practices**:
```python
# ✅ Good: Specific exceptions, logging, context
try:
    result = await process_data(data)
except ValueError as e:
    logger.error(f"Invalid data format: {e}", extra={"data": data})
    raise HTTPException(status_code=400, detail=str(e))
except DatabaseError as e:
    logger.error(f"Database error: {e}", extra={"operation": "process_data"})
    raise HTTPException(status_code=500, detail="Database error")
finally:
    await cleanup_resources()

# ❌ Bad: Bare except, no logging
try:
    result = process_data(data)
except:
    pass
```

### 4. Resource Management
- [ ] Use context managers (`with`, `async with`) for resources
- [ ] Close connections, files, and async generators
- [ ] Use connection pooling for databases
- [ ] Set timeouts for external API calls
- [ ] Implement graceful shutdown

**Example**:
```python
# ✅ Good: Context manager ensures cleanup
async with aiohttp.ClientSession() as session:
    async with session.get(url, timeout=5.0) as response:
        data = await response.json()

# ❌ Bad: Manual management, no cleanup
session = aiohttp.ClientSession()
response = await session.get(url)
data = await response.json()
# Forgot to close!
```

### 5. Logging & Observability
- [ ] Use structured logging (JSON format)
- [ ] Include request ID in logs for tracing
- [ ] Log at appropriate levels (DEBUG, INFO, WARNING, ERROR)
- [ ] Don't log sensitive data (passwords, API keys, PII)
- [ ] Use logging context managers for request-scoped data

### 6. Performance Optimization
- [ ] Use list comprehensions over loops when appropriate
- [ ] Avoid repeated database queries (N+1 problem)
- [ ] Use `asyncio.gather()` for parallel I/O operations
- [ ] Cache expensive computations
- [ ] Profile before optimizing (don't guess)

---

## FastAPI-Specific Best Practices (2026)

### 1. Request/Response Models (Pydantic)
- [ ] Use Pydantic models for all request/response bodies
- [ ] Leverage Pydantic V2 features (field validators, computed fields)
- [ ] Use `Field()` for validation constraints
- [ ] Separate request and response models (don't reuse)
- [ ] Use `Config` class for model configuration

**Best Practices**:
```python
from pydantic import BaseModel, Field, field_validator


# ✅ Good: Validation, documentation, type safety
class UserCreate(BaseModel):
    email: str = Field(..., pattern=r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")
    password: str = Field(..., min_length=8, max_length=128)
    age: int = Field(..., ge=18, le=150)

    @field_validator("email")
    def email_must_be_lowercase(cls, v):
        return v.lower()


# ❌ Bad: No validation, plain dict
@app.post("/users")
async def create_user(data: dict):
    email = data.get("email")
    password = data.get("password")
    # No validation!
```

### 2. Dependency Injection
- [ ] Use `Depends()` for shared logic (auth, DB, config)
- [ ] Create reusable dependency functions
- [ ] Use dependency injection for testability
- [ ] Avoid global state (use FastAPI's app state)
- [ ] Use `Annotated` for cleaner dependency syntax (Python 3.9+)

**Example**:
```python
from typing import Annotated
from fastapi import Depends


# ✅ Good: Reusable dependency
async def get_current_user(token: Annotated[str, Depends(oauth2_scheme)]) -> User:
    return await verify_token(token)


@app.get("/me")
async def read_users_me(current_user: Annotated[User, Depends(get_current_user)]):
    return current_user


# ❌ Bad: Duplicated auth logic in every endpoint
@app.get("/me")
async def read_users_me(token: str):
    user = await verify_token(token)  # Repeated in every endpoint
    return user
```

### 3. Error Handling & HTTP Exceptions
- [ ] Use `HTTPException` for API errors
- [ ] Provide meaningful error messages
- [ ] Use appropriate HTTP status codes
- [ ] Create custom exception handlers for common errors
- [ ] Return structured error responses

**Best Practices**:
```python
from fastapi import HTTPException, status
from fastapi.responses import JSONResponse


# ✅ Good: Custom exception handler
@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={"error": "validation_error", "message": str(exc), "request_id": request.state.request_id},
    )


# ✅ Good: Meaningful HTTP exceptions
@app.get("/users/{user_id}")
async def get_user(user_id: int):
    user = await db.fetch_user(user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"User {user_id} not found")
    return user


# ❌ Bad: Generic errors, no context
@app.get("/users/{user_id}")
async def get_user(user_id: int):
    user = await db.fetch_user(user_id)
    if not user:
        raise HTTPException(status_code=500, detail="Error")
```

### 4. Background Tasks
- [ ] Use `BackgroundTasks` for non-blocking operations
- [ ] Keep background tasks lightweight
- [ ] Use task queues (Celery, RQ) for heavy/long-running tasks
- [ ] Handle errors in background tasks
- [ ] Don't rely on background task results in response

**Example**:
```python
from fastapi import BackgroundTasks


async def send_email(email: str, message: str):
    # Email sending logic
    pass


@app.post("/users")
async def create_user(user: UserCreate, background_tasks: BackgroundTasks):
    new_user = await db.create_user(user)
    background_tasks.add_task(send_email, user.email, "Welcome!")
    return new_user  # Return immediately, email sent in background
```

### 5. Path Operations & Routing
- [ ] Use proper HTTP methods (GET, POST, PUT, DELETE, PATCH)
- [ ] Use path parameters for resource IDs
- [ ] Use query parameters for filtering/pagination
- [ ] Use request body for complex data
- [ ] Version your APIs (`/api/v1/...`)
- [ ] Use `APIRouter` for modular routing

**Structure**:
```python
from fastapi import APIRouter

# ✅ Good: Modular routing
router = APIRouter(prefix="/api/v1/users", tags=["users"])


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(user_id: int):
    pass


@router.post("/", response_model=UserResponse, status_code=201)
async def create_user(user: UserCreate):
    pass


app.include_router(router)
```

### 6. Middleware & Lifecycle Events
- [ ] Use middleware for cross-cutting concerns (logging, auth, CORS)
- [ ] Use startup/shutdown events for resource initialization
- [ ] Keep middleware logic lightweight
- [ ] Order middleware correctly (auth before routing)

**Example**:
```python
@app.on_event("startup")
async def startup_event():
    await database.connect()
    logger.info("Database connected")


@app.on_event("shutdown")
async def shutdown_event():
    await database.disconnect()
    logger.info("Database disconnected")


@app.middleware("http")
async def add_request_id(request: Request, call_next):
    request_id = str(uuid.uuid4())
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response
```

### 7. Testing
- [ ] Use `TestClient` for integration tests
- [ ] Use `pytest` with `pytest-asyncio`
- [ ] Mock external dependencies
- [ ] Test error cases, not just happy path
- [ ] Use fixtures for shared test setup

### 8. Documentation
- [ ] Provide docstrings for all endpoints
- [ ] Use `description` in path operations
- [ ] Use `response_description` for clarity
- [ ] Leverage automatic OpenAPI docs (`/docs`, `/redoc`)
- [ ] Add examples to Pydantic models

---

## Project-Specific: AI Bridge Best Practices

### 1. AWS Bedrock Integration
- [ ] Implement retry logic with exponential backoff
- [ ] Handle throttling (30 req/min limit)
- [ ] Set appropriate timeouts
- [ ] Log request/response for debugging
- [ ] Monitor token usage and costs

### 2. RAG System (ChromaDB)
- [ ] Use connection pooling
- [ ] Cache frequent queries
- [ ] Monitor query performance (<11s target)
- [ ] Handle ChromaDB unavailability gracefully
- [ ] Validate embedding dimensions

### 3. MCP Integration
- [ ] Implement fallback for MCP failures
- [ ] Set timeouts for MCP calls
- [ ] Log MCP tool usage
- [ ] Handle tool not found errors
- [ ] Rate limit MCP calls to external services

### 4. LangSmith Observability
- [ ] Trace all LLM calls
- [ ] Trace RAG queries
- [ ] Trace MCP tool invocations
- [ ] Add custom metadata to traces
- [ ] Monitor trace performance

---

## Common Anti-Patterns to Avoid

### 1. ❌ Blocking I/O in Async Functions
```python
# Bad
async def process_data():
    time.sleep(10)  # Blocks entire event loop!


# Good
async def process_data():
    await asyncio.sleep(10)  # Non-blocking
```

### 2. ❌ Not Using Response Models
```python
# Bad
@app.get("/users/{user_id}")
async def get_user(user_id: int) -> dict:
    return {"id": user_id, "password_hash": "..."}  # Exposes sensitive data!


# Good
@app.get("/users/{user_id}", response_model=UserResponse)
async def get_user(user_id: int) -> User:
    return user  # Response model filters fields
```

### 3. ❌ Global Database Connections
```python
# Bad
db = Database()  # Global connection


# Good
async def get_db():
    db = Database()
    try:
        yield db
    finally:
        await db.close()


@app.get("/users")
async def get_users(db: Database = Depends(get_db)):
    pass
```

### 4. ❌ Not Handling Pydantic ValidationError
```python
# Bad
@app.post("/users")
async def create_user(data: dict):  # No validation
    user = User(**data)  # Can raise ValidationError


# Good
@app.post("/users")
async def create_user(user: UserCreate):  # FastAPI handles validation
    # user is already validated
    pass
```

---

## Security Checklist

### 1. Authentication & Authorization
- [ ] Use OAuth2/JWT for authentication
- [ ] Validate tokens on every request
- [ ] Use `Security` dependency for scope-based auth
- [ ] Don't store passwords in plain text
- [ ] Implement rate limiting

### 2. Input Validation
- [ ] Validate all user input (Pydantic handles this)
- [ ] Sanitize inputs to prevent injection attacks
- [ ] Use `Field()` constraints (min_length, max_length, regex)
- [ ] Validate file uploads (size, type, content)

### 3. CORS & Headers
- [ ] Configure CORS properly (don't use `allow_origins=["*"]` in production)
- [ ] Set security headers (CSP, X-Frame-Options, etc.)
- [ ] Use HTTPS in production
- [ ] Set proper cookie flags (httponly, secure, samesite)

### 4. Secrets Management
- [ ] Never hardcode secrets in code
- [ ] Use environment variables or secret managers
- [ ] Don't log secrets
- [ ] Rotate secrets regularly

---

## Performance Checklist

### 1. Database Optimization
- [ ] Use connection pooling
- [ ] Implement caching for frequent queries
- [ ] Use indexes on frequently queried columns
- [ ] Avoid N+1 query problem
- [ ] Use `asyncio.gather()` for parallel queries

### 2. API Optimization
- [ ] Use response compression (gzip)
- [ ] Implement pagination for large result sets
- [ ] Use streaming for large responses
- [ ] Cache expensive computations
- [ ] Set appropriate timeouts

### 3. Monitoring
- [ ] Monitor response times (p50, p95, p99)
- [ ] Track error rates
- [ ] Monitor memory usage
- [ ] Track external API latency
- [ ] Set up alerting

---

## Resources

### Official Documentation
- [FastAPI Docs](https://fastapi.tiangolo.com/)
- [Pydantic V2 Docs](https://docs.pydantic.dev/latest/)
- [Python Async Docs](https://docs.python.org/3/library/asyncio.html)

### Best Practices
- [FastAPI Best Practices (2026)](https://github.com/zhanymkanov/fastapi-best-practices)
- [Python API Development with FastAPI](https://zyneto.com/blog/python-api-development-with-fastapi)
- [FastAPI High Performance APIs](https://www.boundev.com/blog/fastapi-high-performance-python-apis)

### Error Handling
- [FastAPI Error Handling](https://fastapi.tiangolo.com/tutorial/handling-errors/)
- [Pydantic Custom Error Handling](https://www.getorchestra.io/guides/pydantic-custom-error-handling-in-fastapi-a-detailed-tutorial)
- [Robust Error Handling in FastAPI](https://dev.to/buffolander/building-robust-error-handling-in-fastapi-and-avoiding-rookie-mistakes-ifg)
